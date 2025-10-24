// 引入所需的库
const puppeteer = require('puppeteer');
const fs = require('fs').promises; // 使用 fs.promises API
const path = require('path');
const { URL } = require('url');

const GAME_ROOT_URL_HTTP = 'html5.gamedistribution.com/rvvASMiM/545999659d244efc9fa2d4bb3eeb7c38/';

// -------------------------------------------------
// 配置区域
// -------------------------------------------------
const GAME_ROOT_URL = `https://${GAME_ROOT_URL_HTTP}`; 
const DOWNLOAD_BASE_DIR = path.join(__dirname, 'downloads');

// 【新增】配置阶段 3 (清单抓取)
// 1. 我们要搜索哪些文件来查找资源路径？
const MANIFEST_FILE_EXTENSIONS = ['.js', '.json', '.txt', '.xml', '.atlas'];
// 2. 我们要查找哪些“看起来像”资源的文件扩展名？
// (注意: 正则表达式中 '.' 需要转义为 '\.')
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
        // 【优化】对 URL 进行编码，防止路径中包含空格等特殊字符
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
        }, encodedUrl); // 使用编码后的 URL

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
 * 【全新 - 阶段 3: 主动清单抓取】
 * 读取所有已下载的 JS/JSON，查找“按需加载”的资源路径
 */
async function scrapeFromManifests(page, gameRootPathname, localGameDir, processedUrls) {
    console.log('\n--- 阶段 3: 主动抓取 JS/JSON 中引用的“按需加载”资源 ---');

    const manifestUrls = Array.from(processedUrls).filter(url => {
        const ext = path.extname(new URL(url).pathname);
        return MANIFEST_FILE_EXTENSIONS.includes(ext);
    });

    if (manifestUrls.length === 0) {
        console.log('[信息] 未找到 .js 或 .json 文件，跳过阶段 3。');
        return;
    }

    console.log(`[信息] 正在分析 ${manifestUrls.length} 个清单文件 (.js, .json 等)...`);
    
    const newFoundPaths = new Set();
    const manifestPromises = [];

    // 1. 读取所有清单文件，用 RegEx 查找资源路径
    for (const url of manifestUrls) {
        const parsedUrl = new URL(url);
        let relativePath = parsedUrl.pathname.substring(gameRootPathname.length);
        const localPath = path.join(localGameDir, relativePath);
        
        try {
            const content = await fs.readFile(localPath, 'utf-8');
            let match;
            while ((match = RESOURCE_REGEX.exec(content)) !== null) {
                // match[2] 是捕获组 ([\w\-\/\.]+\.(...))
                newFoundPaths.add(match[2]);
            }
        } catch (e) {
            console.warn(`[警告] 无法读取清单文件 ${localPath}: ${e.message}`);
        }
    }

    // 2. 抓取所有新发现的、且未被下载过的资源
    for (const fileRelPath of newFoundPaths) {
        // 构建完整 URL
        // (注意：JS/JSON 中的路径可能是相对的，例如 "assets/img.png"
        // 我们假设它们是相对于游戏根目录的)
        const fileFullUrl = GAME_ROOT_URL + fileRelPath;
        
        if (!processedUrls.has(fileFullUrl)) {
            console.log(`[主动-清单] 发现按需文件: ${fileRelPath}，正在抓取...`);
            processedUrls.add(fileFullUrl); // 立即标记，防止重复

            manifestPromises.push(
                (async () => {
                    try {
                        const buffer = await fetchFromBrowser(page, fileFullUrl);
                        const localSavePath = path.join(localGameDir, fileRelPath);
                        await fs.mkdir(path.dirname(localSavePath), { recursive: true });
                        await fs.writeFile(localSavePath, buffer);
                        console.log(`[成功-清单] 已保存: ${fileRelPath} (大小: ${buffer.length} B)`);
                    } catch (e) {
                        // 404 是很常见的，因为 RegEx 可能会误报
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
 * 主执行函数
 */
async function scrapeGame() {
    console.log(`项目启动... 目标: ${GAME_ROOT_URL}`);
    const downloadPromises = [];
    const processedUrls = new Set();
    
    let browser;
    try {
        browser = await puppeteer.launch();
        const page = await browser.newPage();
        page.setDefaultNavigationTimeout(120000); 

        const gameRootParsed = new URL(GAME_ROOT_URL);
        const gameRootPathname = gameRootParsed.pathname;
        const gameId = gameRootPathname.split('/').filter(Boolean).pop();
        const localGameDir = path.join(DOWNLOAD_BASE_DIR, gameId);
        console.log(`资源将保存到: ${localGameDir}`);

        // --- 阶段 1: 被动抓取 ---
        console.log('\n--- 阶段 1: 被动抓取 (导航和监听) ---');
        page.on('response', (response) => {
            downloadPromises.push(
                processResponse(page, response, gameRootPathname, localGameDir, processedUrls)
            );
        });

        await page.goto(GAME_ROOT_URL, { waitUntil: 'load' });
        console.log('页面 "load" 事件已触发。');
        console.log('额外等待 10 秒以捕获延迟加载...');
        await new Promise(r => setTimeout(r, 10000));
        console.log('额外等待结束。');

        console.log(`\n--- 等待 ${downloadPromises.length} 个已捕获的被动下载任务 ---`);
        await Promise.allSettled(downloadPromises);
        console.log('--- 阶段 1 完成 ---');
        
        // --- 阶段 2: 主动 Unity JSON 抓取 ---
        await scrapeFromUnityJson(page, gameRootPathname, localGameDir, processedUrls);
        
        // --- 阶段 3: 主动清单抓取 (按需加载) ---
        await scrapeFromManifests(page, gameRootPathname, localGameDir, processedUrls);

    } catch (e) {
        console.error(`发生致命错误: ${e.message}`);
    } finally {
        if (browser) {
            await browser.close();
            console.log('\n抓取完成，浏览器已关闭。');
        }
    }
}

// 运行脚本
scrapeGame();