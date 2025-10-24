// 引入所需的库
const puppeteer = require('puppeteer');
const fs = require('fs').promises; // 使用 fs.promises API
const path = require('path');
const { URL } = require('url');

// -------------------------------------------------
// 配置区域
// -------------------------------------------------
const GAME_ROOT_URL_HTTP = 'html5.gamedistribution.com/rvvASMiM/4a042de4eb3d448cb1a31d6cc7382b02/';
const GAME_ROOT_URL = `https://${GAME_ROOT_URL_HTTP}`; 

const GAME_SLUG_NAME = "coffee-match-rush:-sort-puzzle";

const DOWNLOAD_BASE_DIR = path.join(__dirname, 'downloads');


// 配置阶段 3 (清单抓取)
const MANIFEST_FILE_EXTENSIONS = ['.js', '.json', '.txt', '.xml', '.atlas'];
const RESOURCE_REGEX = new RegExp(
    // 匹配 "path/to/file.ext" 或 'path/to/file.ext'
    /(["'])([\w\-\/\.]+\.(json|png|jpg|jpeg|mp3|ogg|bin|data|bundle|txt|xml|atlas|unityweb|wasm))\1/g
);
// -------------------------------------------------


/**
 * 辅助函数：在浏览器上下文中 fetch 资源
 */
async function fetchFromBrowser(page, url) {
    try {
        if (page.isClosed()) {
            throw new Error('Page was closed');
        }
        const encodedUrl = encodeURI(url);
        
        const arrayData = await page.evaluate(async (url) => {
            try {
                const response = await fetch(url, { cache: 'default' });
                if (!response.ok) {
                    return { error: `Fetch failed with status ${response.status} for ${url}` };
                }
                const buffer = await response.arrayBuffer();
                return Array.from(new Uint8Array(buffer));
            } catch (e) {
                return { error: e.message };
            }
        }, encodedUrl); 

        if (arrayData.error) {
            throw new Error(arrayData.error);
        }
        return Buffer.from(arrayData);
    } catch (e) {
        throw new Error(`fetchFromBrowser failed for ${url}: ${e.message}`);
    }
}

/**
 * 【被动】处理单个响应的异步函数
 */
async function processResponse(page, response, gameRootPathname, localGameDir, processedUrls) {
    const requestUrl = response.url();
    const status = response.status();

    if (!requestUrl.startsWith(GAME_ROOT_URL) || status >= 400 || processedUrls.has(requestUrl)) {
        return; 
    }
    processedUrls.add(requestUrl); 

    const parsedUrl = new URL(requestUrl);
    let relativePath = parsedUrl.pathname.substring(gameRootPathname.length);
    if (relativePath === '' || relativePath === '/') {
        relativePath = 'index.html';
    }
    const localSavePath = path.join(localGameDir, relativePath);

    let buffer;
    try {
        if (status === 304) {
            console.log(`[缓存 304] ${relativePath}, 使用 fetch...`);
            buffer = await fetchFromBrowser(page, requestUrl);
        } else if (status >= 200 && status < 300) {
            try {
                buffer = await response.buffer();
            } catch (e) {
                if (e.message.includes('Request content was evicted from inspector cache')) {
                    console.warn(`[警告] ${relativePath} 缓存被逐出, 尝试备用 fetch...`);
                    buffer = await fetchFromBrowser(page, requestUrl);
                } else {
                    throw e; 
                }
            }
        } else {
            return; 
        }

        if (buffer) {
            await fs.mkdir(path.dirname(localSavePath), { recursive: true });
            await fs.writeFile(localSavePath, buffer);
            console.log(`[成功-被动] 已保存: ${relativePath} (大小: ${buffer.length} B)`);
        }
    } catch (error) {
        if (!error.message.includes('Target closed')) {
            console.error(`[失败-被动] 处理 ${relativePath} 时出错: ${error.message}`);
        }
    }
}

/**
 * 【主动-JSON】检查 Unity JSON 配置文件并抓取缺失的资源
 */
async function scrapeFromUnityJson(page, gameRootPathname, localGameDir, processedUrls) {
    console.log('\n--- 阶段 2: 主动检查 Unity JSON ---');
    
    const jsonUrl = Array.from(processedUrls).find(url => 
        url.startsWith(GAME_ROOT_URL) && url.endsWith('.json')
    );

    if (!jsonUrl) {
        console.log('[信息] 未找到 Unity .json 配置文件，跳过阶段 2。');
        console.log('--- 阶段 2 完成 ---');
        return;
    }

    const parsedJsonUrl = new URL(jsonUrl);
    let jsonRelativePath = parsedJsonUrl.pathname.substring(gameRootPathname.length);
    const localJsonPath = path.join(localGameDir, jsonRelativePath);
    
    let config;
    try {
        const data = await fs.readFile(localJsonPath, 'utf-8');
        config = JSON.parse(data);
    } catch (e) {
        console.error(`[失败] 无法读取本地JSON ${localJsonPath}: ${e.message}`);
        console.log('--- 阶段 2 完成 ---');
        return;
    }

    const urlKeys = ['dataUrl', 'wasmCodeUrl', 'wasmFrameworkUrl', 'wasmSymbolsUrl'];
    const manualPromises = [];
    const buildDir = path.dirname(jsonRelativePath); 

    for (const key of urlKeys) {
        const filename = config[key];
        if (!filename || typeof filename !== 'string') continue;

        const fileRelPath = path.join(buildDir, filename).replace(/\\/g, '/'); 
        const fileFullUrl = GAME_ROOT_URL + fileRelPath;

        if (!processedUrls.has(fileFullUrl)) {
            console.log(`[主动-JSON] 发现缺失文件 (${key}): ${fileRelPath}，正在抓取...`);
            processedUrls.add(fileFullUrl); 
            
            manualPromises.push(
                (async () => {
                    try {
                        const buffer = await fetchFromBrowser(page, fileFullUrl);
                        const localSavePath = path.join(localGameDir, fileRelPath);
                        await fs.mkdir(path.dirname(localSavePath), { recursive: true });
                        await fs.writeFile(localSavePath, buffer);
                        console.log(`[成功-主动] 已保存: ${fileRelPath} (大小: ${buffer.length} B)`);
                    } catch (e) {
                        console.error(`[失败-主动] 抓取 ${fileRelPath} 失败: ${e.message}`);
                    }
                })()
            );
        }
    }

    if (manualPromises.length > 0) {
        await Promise.allSettled(manualPromises);
    }
    console.log('--- 阶段 2 完成 ---');
}


/**
 * 【主动-清单】读取所有已下载的 JS/JSON，查找“按需加载”的资源路径
 */
async function scrapeFromManifests(page, gameRootPathname, localGameDir, processedUrls) {
    console.log('\n--- 阶段 3: 主动抓取 JS/JSON 中引用的“按需加载”资源 ---');

    const manifestUrls = Array.from(processedUrls).filter(url => {
        const ext = path.extname(new URL(url).pathname);
        return MANIFEST_FILE_EXTENSIONS.includes(ext);
    });

    if (manifestUrls.length === 0) {
        console.log('[信息] 未找到 .js 或 .json 文件，跳过阶段 3。');
        console.log('--- 阶段 3 完成 ---');
        return;
    }

    console.log(`[信息] 正在分析 ${manifestUrls.length} 个清单文件 (.js, .json 等)...`);
    
    const newFoundPaths = new Set();
    const manifestPromises = [];

    for (const url of manifestUrls) {
        const parsedUrl = new URL(url);
        let relativePath = parsedUrl.pathname.substring(gameRootPathname.length);
        const localPath = path.join(localGameDir, relativePath);
        
        try {
            const content = await fs.readFile(localPath, 'utf-8');
            let match;
            while ((match = RESOURCE_REGEX.exec(content)) !== null) {
                newFoundPaths.add(match[2]);
            }
        } catch (e) {
            console.warn(`[警告] 无法读取清单文件 ${localPath}: ${e.message}`);
        }
    }

    for (const fileRelPath of newFoundPaths) {
        const fileFullUrl = GAME_ROOT_URL + fileRelPath;
        
        if (!processedUrls.has(fileFullUrl)) {
            console.log(`[主动-清单] 发现按需文件: ${fileRelPath}，正在抓取...`);
            processedUrls.add(fileFullUrl); 

            manifestPromises.push(
                (async () => {
                    try {
                        const buffer = await fetchFromBrowser(page, fileFullUrl);
                        const localSavePath = path.join(localGameDir, fileRelPath);
                        await fs.mkdir(path.dirname(localSavePath), { recursive: true });
                        await fs.writeFile(localSavePath, buffer);
                        console.log(`[成功-清单] 已保存: ${fileRelPath} (大小: ${buffer.length} B)`);
                    } catch (e) {
                        if (e.message.includes('Fetch failed with status 404')) {
                            console.log(`[跳过-404] ${fileRelPath} (可能是 RegEx 误报)`);
                        } else {
                            console.error(`[失败-清单] 抓取 ${fileRelPath} 失败: ${e.message}`);
                        }
                    }
                })()
            );
        }
    }

    if (manifestPromises.length > 0) {
        console.log(`--- 等待 ${manifestPromises.length} 个“按需加载”任务 ---`);
        await Promise.allSettled(manifestPromises);
    }
    console.log('--- 阶段 3 完成 ---');
}


/**
 * 【阶段 0: 抓取元数据】
 */
async function scrapeMetadata(page, url) {
    console.log(`正在从 ${url} 抓取元数据...`);
    try {
        
        await page.goto(url, { 
            waitUntil: 'load', 
            timeout: 60000 
        });

        // v8.2 的精确选择器
        const metadata = await page.evaluate(() => {
            
            const findContentByHeading = (text) => {
                try {
                    const heading = Array.from(document.querySelectorAll('h3'))
                                         .find(h => h.innerText.trim().toLowerCase() === text.toLowerCase());
                    return heading?.nextElementSibling?.innerText.trim() || null;
                } catch (e) { return null; }
            };

            const gameName = document.querySelector('span:has(strong.font-semibold) > strong')?.innerText.trim() || null;
            const publishedBy = document.querySelector('a[href*="company="]')?.innerText.trim() || null;
            const description = findContentByHeading('description');
            const instructions = findContentByHeading('instructions');
            const tags = Array.from(document.querySelectorAll('div.tags > span.tag')).map(s => s.innerText.trim());
            const category = document.querySelector('a[href*="/categories/"]')?.innerText.trim() || null;

            // 【!!! 核心优化 v9 !!!】
            let imageUrl = null;

            // 策略 1: 尝试 'og:image' (最可靠)
            imageUrl = document.querySelector('meta[property="og:image"]')?.content || null;

            // 策略 2: 备用方案，使用你提供的 class 抓取 512x512 的图片
            if (!imageUrl) {
                imageUrl = document.querySelector('div.games_gameThumnailImage__eM2Tb img[alt*="-512x512"]')?.src || null;
            }
            
            // 策略 3: 备用方案，抓取画廊中的第一张图
            if (!imageUrl) {
                imageUrl = document.querySelector('div.games_gameThumnailImage__eM2Tb img')?.src || null;
            }

            return { gameName, description, instructions, category, publishedBy, tags, imageUrl };
        });

        console.log('[成功-元数据] 已抓取元数据。');
        return metadata;

    } catch (e) {
        console.error(`[失败-元数据] 抓取元数据失败: ${e.message}`);
        return { gameName: null, description: null, instructions: null, category: null, publishedBy: null, tags: [], imageUrl: null }; 
    }
}

/**
 * 【阶段 0: 抓取缩略图】
 * 【!!! 核心优化 v9 !!!】
 */
async function scrapeImage(page, imageUrl, localGameDir) {
    if (!imageUrl) {
        console.log('[信息] 未在元数据页面找到 imageUrl，跳过缩略图下载。');
        return;
    }
    
    console.log(`[信息] 正在抓取缩略图: ${imageUrl}`);
    
    try {
        // 1. 从 URL 动态获取扩展名
        const parsedUrl = new URL(imageUrl);
        const extension = path.extname(parsedUrl.pathname); // e.g., '.jpg' or '.png'

        // 2. 将其保存为 'thumbnail' + 原始扩展名
        const savePath = path.join(localGameDir, `thumbnail${extension}`);
        
        // 3. 使用 fetchFromBrowser 下载
        const buffer = await fetchFromBrowser(page, imageUrl);
        
        await fs.mkdir(path.dirname(savePath), { recursive: true });
        await fs.writeFile(savePath, buffer);
        console.log(`[成功-图片] 缩略图已保存到 ${savePath}`);
    } catch (e) {
        console.error(`[失败-图片] 抓取缩略图失败: ${e.message}`);
    }
}


/**
 * 保存元数据到 .txt 文件
 */
async function saveMetadata(localGameDir, metadata) {
    if (!metadata.gameName && !metadata.description) {
        console.log('[信息] 未抓取到元数据，跳过保存 game_info.txt。');
        return;
    }

    const content = `### 游戏名称 (Game Title) ###
${metadata.gameName || 'N/A'}

### 发行商 (Published by) ###
${metadata.publishedBy || 'N/A'}

### 描述 (DESCRIPTION) ###
${metadata.description || 'N/A'}

### 操作指南 (INSTRUCTIONS) ###
${metadata.instructions || 'N/A'}

### 分类 (Category) ###
${metadata.category || 'N/A'}

### 标签 (Tags) ###
${metadata.tags?.join(', ') || 'N/A'}
`;

    try {
        const savePath = path.join(localGameDir, 'game_info.txt');
        await fs.mkdir(path.dirname(savePath), { recursive: true });
        await fs.writeFile(savePath, content.trim());
        console.log(`[成功] 元数据已保存到 ${savePath}`);
    } catch (e) {
        console.error(`[失败] 写入元数据文件失败: ${e.message}`);
    }
}


/**
 * 主执行函数
 */
async function scrapeGame() {
    console.log(`项目启动... 目标: ${GAME_ROOT_URL}`);
    const downloadPromises = [];
    const processedUrls = new Set();
    
    let browser;
    try {
        // 1. 启动浏览器
        browser = await puppeteer.launch();

        // 2. 解析 URL
        const gameRootParsed = new URL(GAME_ROOT_URL);
        const gameRootPathname = gameRootParsed.pathname;

        const pathParts = gameRootPathname.split('/').filter(Boolean);
        
        // 【重要】
        // gameInstanceId 是 4a042de... (最后一部分)，用于文件夹命名
        const gameInstanceId = pathParts[pathParts.length - 1]; 
        // LANDING_PAGE_URL 使用你提供的 GAME_SLUG_NAME
        const LANDING_PAGE_URL = `https://gamedistribution.com/games/${GAME_SLUG_NAME}`;
        
        // 文件夹路径使用实例 ID (4a042de...)
        const localGameDir = path.join(DOWNLOAD_BASE_DIR, gameInstanceId);
        console.log(`资源将保存到: ${localGameDir}`);


        // --- 阶段 0: 抓取元数据和图片 ---
        console.log('\n--- 阶段 0: 抓取元数据 (Metadata) ---');
        const metadataPage = await browser.newPage();
        
        // 0a: 抓取文本元数据 (现在也包含 imageUrl)
        const metadata = await scrapeMetadata(metadataPage, LANDING_PAGE_URL);
        await saveMetadata(localGameDir, metadata);
        
        // 0b: 抓取缩略图 (使用元数据中的 imageUrl)
        // 【!!! 核心优化 v9 !!!】
        await scrapeImage(metadataPage, metadata.imageUrl, localGameDir);
        
        await metadataPage.close();
        console.log('--- 阶段 0 完成 ---');


        // --- 阶段 1: 被动抓取 (导航和监听) ---
        console.log('\n--- 阶段 1: 被动抓取 (导航和监听) ---');
        const gamePage = await browser.newPage(); // 使用新页面
        gamePage.setDefaultNavigationTimeout(120000); 

        gamePage.on('response', (response) => {
            downloadPromises.push(
                processResponse(gamePage, response, gameRootPathname, localGameDir, processedUrls)
            );
        });

        await gamePage.goto(GAME_ROOT_URL, { waitUntil: 'load' });
        console.log('页面 "load" 事件已触发。');
        console.log('额外等待 10 秒以捕获延迟加载...');
        await new Promise(r => setTimeout(r, 10000));
        console.log('额外等待结束。');

        console.log(`\n--- 等待 ${downloadPromises.length} 个已捕获的被动下载任务 ---`);
        await Promise.allSettled(downloadPromises);
        console.log('--- 阶段 1 完成 ---');
        
        // --- 阶段 2: 主动 Unity JSON 抓取 ---
        await scrapeFromUnityJson(gamePage, gameRootPathname, localGameDir, processedUrls);
        
        // --- 阶段 3: 主动清单抓取 (按需加载) ---
        await scrapeFromManifests(gamePage, gameRootPathname, localGameDir, processedUrls);

    } catch (e) {
        console.error(`发生致命错误: ${e.message}`);
    } finally {
        if (browser) {
            await browser.close();
            console.log('\n抓取完成，浏览器已关闭。');
        }
    }
}

// -------------------------------------------------
// 运行脚本
// -------------------------------------------------
scrapeGame();