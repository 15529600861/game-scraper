// 【v12 升级】 引入 puppeteer-extra 和 stealth 插件
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin()); // 激活隐身模式

const fs = require('fs').promises; // 使用 fs.promises API
const path = require('path');
const { URL } = require('url');

// -------------------------------------------------
// ----------------- 全局配置区域 ------------------
// -------------------------------------------------

const GAMES_TO_SCRAPE = [
    { 
        slug: "hexa-go!", 
        http_root: "2c78611ed1104149a04c99a4f9f017b6" 
    },
    { 
        slug: "red-stickman-vs-craftmans-2", 
        http_root: "ee8b2be14fa24256b113d31a90835383" 
    },
    // ... 在这里添加更多游戏
];

const CONCURRENCY_LIMIT = 3;

// 【v12 升级】 反反爬虫配置
const RETRY_LIMIT = 3; // 页面导航的重试次数
const STAGGER_DELAY_MS = 5000; // 启动每个新任务之间的延迟 (5秒)

// --- 其他全局配置 ---
const DOWNLOAD_BASE_DIR = path.join(__dirname, 'downloads');
const MANIFEST_FILE_EXTENSIONS = ['.js', '.json', '.txt', '.xml', '.atlas'];
const RESOURCE_REGEX = new RegExp(
    /(["'])([\w\-\/\.]+\.(json|png|jpg|jpeg|mp3|ogg|bin|data|bundle|txt|xml|atlas|unityweb|wasm))\1/g
);
// -------------------------------------------------
// ------------- 辅助函数 (全局) -------------------
// -------------------------------------------------

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 【v12 升级】带重试的 goto 函数
 */
async function gotoWithRetries(page, url, logPrefix, options) {
    for (let i = 1; i <= RETRY_LIMIT; i++) {
        try {
            await page.goto(url, options);
            // 成功
            return true;
        } catch (e) {
            console.error(`${logPrefix} [失败] 导航到 ${url} 失败 (第 ${i} 次尝试): ${e.message}`);
            if (i < RETRY_LIMIT) {
                const waitTime = i * 2000; // 2s, 4s, ...
                console.log(`${logPrefix} [信息] ${waitTime/1000}秒后重试...`);
                await delay(waitTime);
            }
        }
    }
    // 所有重试均失败
    throw new Error(`导航到 ${url} 失败 ${RETRY_LIMIT} 次。`);
}

// -------------------------------------------------
// ------------- 单个游戏的工作函数 ----------------
// -------------------------------------------------

/**
 * 这是一个完全独立的函数，负责抓取单个游戏。
 */
async function scrapeGame(game, workerId) {
    // --- 1. 设置此任务的常量 ---
    const { slug: GAME_SLUG_NAME, http_root: GAME_ROOT_URL_HTTP } = game;
    const GAME_ROOT_URL = `https://html5.gamedistribution.com/rvvASMiM/${GAME_ROOT_URL_HTTP}/`;
    const logPrefix = `[Worker ${workerId} | ${GAME_SLUG_NAME}]`;
    
    console.log(`${logPrefix} 任务启动... 目标: ${GAME_ROOT_URL}`);

    // --- 2. 内部化所有辅助函数 (实现隔离) ---

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
                console.log(`${logPrefix} [缓存 304] ${relativePath}, 使用 fetch...`);
                buffer = await fetchFromBrowser(page, requestUrl);
            } else if (status >= 200 && status < 300) {
                try {
                    buffer = await response.buffer();
                } catch (e) {
                    if (e.message.includes('Request content was evicted from inspector cache')) {
                        console.warn(`${logPrefix} [警告] ${relativePath} 缓存被逐出, 尝试备用 fetch...`);
                        buffer = await fetchFromBrowser(page, requestUrl);
                    } else { throw e; }
                }
            } else { return; }
            if (buffer) {
                await fs.mkdir(path.dirname(localSavePath), { recursive: true });
                await fs.writeFile(localSavePath, buffer);
                console.log(`${logPrefix} [成功-被动] 已保存: ${relativePath} (大小: ${buffer.length} B)`);
            }
        } catch (error) {
            if (!error.message.includes('Target closed')) {
                console.error(`${logPrefix} [失败-被动] 处理 ${relativePath} 时出错: ${error.message}`);
            }
        }
    }

    async function scrapeFromUnityJson(page, gameRootPathname, localGameDir, processedUrls) {
        console.log(`\n${logPrefix} --- 阶段 2: 主动检查 Unity JSON ---`);
        const jsonUrl = Array.from(processedUrls).find(url => url.startsWith(GAME_ROOT_URL) && url.endsWith('.json'));
        if (!jsonUrl) {
            console.log(`${logPrefix} [信息] 未找到 Unity .json 配置文件，跳过阶段 2。`);
            console.log(`${logPrefix} --- 阶段 2 完成 ---`);
            return;
        }
        const parsedJsonUrl = new URL(jsonUrl);
        let jsonRelativePath = parsedJsonUrl.pathname.substring(gameRootPathname.length);
        const localJsonPath = path.join(localGameDir, jsonRelativePath);
        let config;
        try {
            config = JSON.parse(await fs.readFile(localJsonPath, 'utf-8'));
        } catch (e) {
            console.error(`${logPrefix} [失败] 无法读取本地JSON ${localJsonPath}: ${e.message}`);
            console.log(`${logPrefix} --- 阶段 2 完成 ---`);
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
                console.log(`${logPrefix} [主动-JSON] 发现缺失文件 (${key}): ${fileRelPath}，正在抓取...`);
                processedUrls.add(fileFullUrl); 
                manualPromises.push(
                    (async () => {
                        try {
                            const buffer = await fetchFromBrowser(page, fileFullUrl);
                            const localSavePath = path.join(localGameDir, fileRelPath);
                            await fs.mkdir(path.dirname(localSavePath), { recursive: true });
                            await fs.writeFile(localSavePath, buffer);
                            console.log(`${logPrefix} [成功-主动] 已保存: ${fileRelPath} (大小: ${buffer.length} B)`);
                        } catch (e) {
                            console.error(`${logPrefix} [失败-主动] 抓取 ${fileRelPath} 失败: ${e.message}`);
                        }
                    })()
                );
            }
        }
        if (manualPromises.length > 0) await Promise.allSettled(manualPromises);
        console.log(`${logPrefix} --- 阶段 2 完成 ---`);
    }

    // 【v11 递归清单扫描】
    async function scrapeFromManifestsRecursive(page, gameRootPathname, localGameDir, processedUrls) {
        console.log(`\n${logPrefix} --- 阶段 3: 主动抓取(递归) JS/JSON 中的引用资源 ---`);
        const scannedManifests = new Set();
        let loopCount = 0; 
        while (loopCount < 10) { 
            loopCount++;
            const manifestsToScan = Array.from(processedUrls).filter(url => {
                const ext = path.extname(new URL(url).pathname);
                return MANIFEST_FILE_EXTENSIONS.includes(ext) && !scannedManifests.has(url);
            });
            if (manifestsToScan.length === 0) {
                console.log(`${logPrefix} [信息] (循环 ${loopCount-1}) 未发现新的清单文件，递归扫描完成。`);
                break;
            }
            console.log(`${logPrefix} [信息] (循环 ${loopCount}) 发现 ${manifestsToScan.length} 个新清单，正在扫描...`);
            const newResourcesToDownload = new Map();
            for (const manifestUrl of manifestsToScan) {
                scannedManifests.add(manifestUrl);
                const parsedUrl = new URL(manifestUrl);
                let relativePath = parsedUrl.pathname.substring(gameRootPathname.length);
                const localPath = path.join(localGameDir, relativePath);
                try {
                    const content = await fs.readFile(localPath, 'utf-8');
                    let match;
                    while ((match = RESOURCE_REGEX.exec(content)) !== null) {
                        const fileRelPath = match[2];
                        const fileFullUrl = GAME_ROOT_URL + fileRelPath;
                        if (!processedUrls.has(fileFullUrl) && !newResourcesToDownload.has(fileFullUrl)) {
                            newResourcesToDownload.set(fileFullUrl, fileRelPath);
                        }
                    }
                } catch (e) {
                    console.warn(`${logPrefix} [警告] 无法读取清单文件 ${localPath}: ${e.message}`);
                }
            }
            if (newResourcesToDownload.size > 0) {
                console.log(`${logPrefix} [信息] (循环 ${loopCount}) 从清单中发现 ${newResourcesToDownload.size} 个新资源，正在下载...`);
                const downloadPromises = [];
                for (const [fileFullUrl, fileRelPath] of newResourcesToDownload.entries()) {
                    processedUrls.add(fileFullUrl); 
                    downloadPromises.push(
                        (async () => {
                            try {
                                const buffer = await fetchFromBrowser(page, fileFullUrl);
                                const localSavePath = path.join(localGameDir, fileRelPath);
                                await fs.mkdir(path.dirname(localSavePath), { recursive: true });
                                await fs.writeFile(localSavePath, buffer);
                                console.log(`${logPrefix} [成功-清单] 已保存: ${fileRelPath} (大小: ${buffer.length} B)`);
                            } catch (e) {
                                if (e.message.includes('Fetch failed with status 404')) {
                                    console.log(`${logPrefix} [跳过-404] ${fileRelPath} (可能是 RegEx 误报)`);
                                } else {
                                    console.error(`${logPrefix} [失败-清单] 抓取 ${fileRelPath} 失败: ${e.message}`);
                                }
                            }
                        })()
                    );
                }
                await Promise.allSettled(downloadPromises);
            } else {
                 console.log(`${logPrefix} [信息] (循环 ${loopCount}) 新清单中未发现新资源。`);
            }
        }
        if (loopCount >= 10) {
            console.warn(`${logPrefix} [警告] 递归扫描达到10次上限。`);
        }
        console.log(`${logPrefix} --- 阶段 3 完成 ---`);
    }

    async function scrapeMetadata(page, url) {
        console.log(`${logPrefix} 正在从 ${url} 抓取元数据...`);
        try {
            // 【v12 升级】使用带重试的 goto
            await gotoWithRetries(page, url, logPrefix, { 
                waitUntil: 'load', 
                timeout: 120000 // 【v13 升级】超时增加到 120000 毫秒 (2分钟) 
            });

            const metadata = await page.evaluate(() => {
                const findContentByHeading = (text) => {
                    try {
                        const heading = Array.from(document.querySelectorAll('h3')).find(h => h.innerText.trim().toLowerCase() === text.toLowerCase());
                        return heading?.nextElementSibling?.innerText.trim() || null;
                    } catch (e) { return null; }
                };
                const gameName = document.querySelector('span:has(strong.font-semibold) > strong')?.innerText.trim() || null;
                const publishedBy = document.querySelector('a[href*="company="]')?.innerText.trim() || null;
                const description = findContentByHeading('description');
                const instructions = findContentByHeading('instructions');
                const tags = Array.from(document.querySelectorAll('div.tags > span.tag')).map(s => s.innerText.trim());
                const category = document.querySelector('a[href*="/categories/"]')?.innerText.trim() || null;
                let imageUrl = document.querySelector('meta[property="og:image"]')?.content || null;
                if (!imageUrl) {
                    imageUrl = document.querySelector('div.games_gameThumnailImage__eM2Tb img[alt*="-512x512"]')?.src || null;
                }
                if (!imageUrl) {
                    imageUrl = document.querySelector('div.games_gameThumnailImage__eM2Tb img')?.src || null;
                }
                return { gameName, description, instructions, category, publishedBy, tags, imageUrl };
            });
            console.log(`${logPrefix} [成功-元数据] 已抓取元数据。`);
            return metadata;
        } catch (e) {
            console.error(`${logPrefix} [失败-元数据] 抓取元数据失败: ${e.message}`);
            return { gameName: null, description: null, instructions: null, category: null, publishedBy: null, tags: [], imageUrl: null }; 
        }
    }

    async function scrapeImage(page, imageUrl, localGameDir) {
        if (!imageUrl) {
            console.log(`${logPrefix} [信息] 未在元数据页面找到 imageUrl，跳过缩略图下载。`);
            return;
        }
        console.log(`${logPrefix} [信息] 正在抓取缩略图: ${imageUrl}`);
        try {
            const parsedUrl = new URL(imageUrl);
            const extension = path.extname(parsedUrl.pathname); 
            const savePath = path.join(localGameDir, `thumbnail${extension}`);
            const buffer = await fetchFromBrowser(page, imageUrl);
            await fs.mkdir(path.dirname(savePath), { recursive: true });
            await fs.writeFile(savePath, buffer);
            console.log(`${logPrefix} [成功-图片] 缩略图已保存到 ${savePath}`);
        } catch (e) {
            console.error(`${logPrefix} [失败-图片] 抓取缩略图失败: ${e.message}`);
        }
    }

    async function saveMetadata(localGameDir, metadata) {
        if (!metadata.gameName && !metadata.description) {
            console.log(`${logPrefix} [信息] 未抓取到元数据，跳过保存 game_info.txt。`);
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
            console.log(`${logPrefix} [成功] 元数据已保存到 ${savePath}`);
        } catch (e) {
            console.error(`${logPrefix} [失败] 写入元数据文件失败: ${e.message}`);
        }
    }

    // --- 3. 此任务的主执行逻辑 ---
    
    const downloadPromises = [];
    const processedUrls = new Set();
    let browser;
    
    try {
        // 1. 启动此任务的浏览器
        // 【v12 升级】使用 stealth 模式
        browser = await puppeteer.launch({ 
            headless: true, // 推荐使用 "new" 或 true
            // 【v13 升级】增加 protocolTimeout 解决 fetchFromBrowser 的 Runtime.callFunctionOn timed out 错误
            protocolTimeout: 180000, // 180 秒 (3分钟)
        });

        // 2. 解析 URL 和路径
        const gameRootParsed = new URL(GAME_ROOT_URL);
        const gameRootPathname = gameRootParsed.pathname;
        const pathParts = gameRootPathname.split('/').filter(Boolean);
        const gameInstanceId = pathParts[pathParts.length - 1]; 
        const LANDING_PAGE_URL = `https://gamedistribution.com/games/${GAME_SLUG_NAME}`;
        const localGameDir = path.join(DOWNLOAD_BASE_DIR, gameInstanceId);
        console.log(`${logPrefix} 资源将保存到: ${localGameDir}`);

        // --- 阶段 0: 抓取元数据和图片 ---
        console.log(`\n${logPrefix} --- 阶段 0: 抓取元数据 (Metadata) ---`);
        const metadataPage = await browser.newPage();
        const metadata = await scrapeMetadata(metadataPage, LANDING_PAGE_URL); // (内部已包含重试)
        await saveMetadata(localGameDir, metadata);
        await scrapeImage(metadataPage, metadata.imageUrl, localGameDir);
        await metadataPage.close();
        console.log(`${logPrefix} --- 阶段 0 完成 ---`);

        // --- 阶段 1: 被动抓取 (导航和监听) ---
        console.log(`\n${logPrefix} --- 阶段 1: 被动抓取 (导航和监听) ---`);
        const gamePage = await browser.newPage();
        gamePage.setDefaultNavigationTimeout(120000); 
        gamePage.on('response', (response) => {
            downloadPromises.push(
                processResponse(gamePage, response, gameRootPathname, localGameDir, processedUrls)
            );
        });
        
        // 【v12 升级】使用带重试的 goto
        await gotoWithRetries(gamePage, GAME_ROOT_URL, logPrefix, { 
            waitUntil: 'load',
            timeout: 120000 
        });
        
        console.log(`${logPrefix} 页面 "load" 事件已触发。`);
        console.log(`${logPrefix} 额外等待 10 秒以捕获延迟加载...`);
        await delay(10000);
        console.log(`${logPrefix} 额外等待结束。`);
        console.log(`\n${logPrefix} --- 等待 ${downloadPromises.length} 个已捕获的被动下载任务 ---`);
        await Promise.allSettled(downloadPromises);
        console.log(`${logPrefix} --- 阶段 1 完成 ---`);
        
        // --- 阶段 2: 主动 Unity JSON 抓取 ---
        await scrapeFromUnityJson(gamePage, gameRootPathname, localGameDir, processedUrls);
        
        // --- 阶段 3: 递归清单抓取 ---
        await scrapeFromManifestsRecursive(gamePage, gameRootPathname, localGameDir, processedUrls);

    } catch (e) {
        // 捕获此任务的致命错误 (例如 gotoWithRetries 最终失败)
        console.error(`${logPrefix} 发生致命错误: ${e.message}`);
    } finally {
        // 4. 无论成功与否，都关闭此任务的浏览器
        if (browser) {
            await browser.close();
            console.log(`\n${logPrefix} 任务完成，浏览器已关闭。`);
        }
    }
}

// -------------------------------------------------
// -----------------  主执行管理器 -----------------
// -------------------------------------------------

/**
 * 并发池管理器
 */
async function runPool() {
    console.log(`--- 爬虫池启动 ---`);
    console.log(`--- 任务总数: ${GAMES_TO_SCRAPE.length} | 并发数: ${CONCURRENCY_LIMIT} ---`);
    
    const queue = [...GAMES_TO_SCRAPE];
    const runningTasks = [];
    let workerId = 0;

    /**
     * 启动队列中的下一个任务
     */
    function startNextTask() {
        if (queue.length > 0) {
            workerId++;
            const game = queue.shift();
            console.log(`[Manager] 分配任务 ${game.slug} (ID: ${workerId})`);
            
            const taskPromise = scrapeGame(game, workerId)
                .catch(err => {
                    console.error(`[Manager] Worker ${workerId} (${game.slug}) 遭遇未处理的严重错误:`, err);
                })
                .finally(() => {
                    runningTasks.splice(runningTasks.indexOf(taskPromise), 1);
                });
                
            runningTasks.push(taskPromise);
            return taskPromise;
        }
        return null;
    }

    // 1. 启动初始的一批任务
    for (let i = 0; i < CONCURRENCY_LIMIT && queue.length > 0; i++) {
        startNextTask();
        // 【v12 升级】如果还有更多任务要排队，则在启动下一个之前错开时间
        if (i < CONCURRENCY_LIMIT - 1 && queue.length > 0) {
            console.log(`[Manager] 等待 ${STAGGER_DELAY_MS}ms 错峰...`);
            await delay(STAGGER_DELAY_MS);
        }
    }

    // 2. 循环，直到队列为空且没有正在运行的任务
    while (queue.length > 0 || runningTasks.length > 0) {
        
        if (runningTasks.length < CONCURRENCY_LIMIT && queue.length > 0) {
            // 有空槽位，错峰启动新任务
            console.log(`[Manager] 任务完成，有空闲槽位。等待 ${STAGGER_DELAY_MS}ms 错峰...`);
            await delay(STAGGER_DELAY_MS);
            startNextTask();
        } else if (runningTasks.length > 0) {
            // 池已满，或队列已空
            // 等待【任何一个】正在运行的任务完成
            await Promise.race(runningTasks);
        }
        // .finally() 回调会确保已完成的任务被移除
        // 下一轮循环将检查是否有空槽位
    }

    console.log("--- 所有游戏均已处理完毕 ---");
}

// -------------------------------------------------
// -------------------  运行脚本 -------------------
// -------------------------------------------------
runPool();