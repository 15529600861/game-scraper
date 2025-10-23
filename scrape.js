// 引入所需的库
const puppeteer = require('puppeteer');
const fs = require('fs').promises; // 使用 fs.promises API
const path = require('path');
const { URL } = require('url');

// -------------------------------------------------
// 配置区域
// -------------------------------------------------
const GAME_ROOT_URL = 'https://html5.gamedistribution.com/rvvASMiM/8cfbb6f4272b438fa38cb882cc071091/'; 
const DOWNLOAD_BASE_DIR = path.join(__dirname, 'downloads');

// -------------------------------------------------

/**
 * 辅助函数：在浏览器上下文中 fetch 资源
 */
async function fetchFromBrowser(page, url) {
    try {
        if (page.isClosed()) {
            throw new Error('Page was closed');
        }
        const arrayData = await page.evaluate(async (url) => {
            try {
                const response = await fetch(url, { cache: 'default' });
                if (!response.ok) {
                    return { error: `Fetch failed with status ${response.status}` };
                }
                const buffer = await response.arrayBuffer();
                return Array.from(new Uint8Array(buffer));
            } catch (e) {
                return { error: e.message };
            }
        }, url);

        if (arrayData.error) {
            throw new Error(arrayData.error);
        }
        return Buffer.from(arrayData);
    } catch (e) {
        throw new Error(`fetchFromBrowser failed: ${e.message}`);
    }
}

/**
 * 【被动】处理单个响应的异步函数
 */
async function processResponse(page, response, gameRootPathname, localGameDir, processedUrls) {
    const requestUrl = response.url();
    const status = response.status();

    // 过滤
    if (!requestUrl.startsWith(GAME_ROOT_URL) || status >= 400 || processedUrls.has(requestUrl)) {
        return; 
    }
    processedUrls.add(requestUrl); // 标记为已处理

    // ... (内部逻辑不变) ...
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
        // 如果主动抓取先失败了，被动抓取可能会在这里报告 Target closed，这是正常的
        if (!error.message.includes('Target closed')) {
            console.error(`[失败-被动] 处理 ${relativePath} 时出错: ${error.message}`);
        }
    }
}

/**
 * 【主动】检查 JSON 配置文件并抓取缺失的资源
 */
async function scrapeMissingFiles(page, gameRootPathname, localGameDir, processedUrls) {
    console.log('\n--- 阶段 2: 主动检查 JSON 中被跳过的资源 ---');
    
    const jsonUrl = Array.from(processedUrls).find(url => 
        url.startsWith(GAME_ROOT_URL) && url.endsWith('.json')
    );

    if (!jsonUrl) {
        console.log('[信息] 未找到 .json 配置文件，跳过主动检查。');
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
        console.error(`[失败] 无法读取本地JSON配置文件 ${localJsonPath}: ${e.message}`);
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

        // 关键检查：这个文件是否【没有】被被动下载过？
        if (!processedUrls.has(fileFullUrl)) {
            
            console.log(`[主动] 发现缺失文件 (${key}): ${fileRelPath}，正在抓取...`);
            
            // 【!!! 核心修复 !!!】
            // 立即将 URL 标记为“正在处理”，以防止被动监听器重复抓取
            processedUrls.add(fileFullUrl); 
            
            const localSavePath = path.join(localGameDir, fileRelPath);
            
            // 添加到手动下载列表
            manualPromises.push(
                (async () => {
                    try {
                        const buffer = await fetchFromBrowser(page, fileFullUrl);
                        await fs.mkdir(path.dirname(localSavePath), { recursive: true });
                        await fs.writeFile(localSavePath, buffer);
                        console.log(`[成功-主动] 已保存: ${fileRelPath} (大小: ${buffer.length} B)`);
                        // 'processedUrls.add' 已被移动到循环的顶部
                    } catch (e) {
                        console.error(`[失败-主动] 抓取 ${fileRelPath} 失败: ${e.message}`);
                    }
                })()
            );
        }
    }

    if (manualPromises.length > 0) {
        console.log(`--- 等待 ${manualPromises.length} 个主动抓取任务 ---`);
        await Promise.allSettled(manualPromises);
        console.log('--- 主动抓取任务完成 ---');
    } else {
        console.log('[信息] JSON中的所有资源均已在被动阶段下载。');
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
        browser = await puppeteer.launch();
        const page = await browser.newPage();
        
        page.setDefaultNavigationTimeout(120000); 

        const gameRootParsed = new URL(GAME_ROOT_URL);
        const gameRootPathname = gameRootParsed.pathname;
        const gameId = gameRootPathname.split('/').filter(Boolean).pop();
        const localGameDir = path.join(DOWNLOAD_BASE_DIR, gameId);
        console.log(`资源将保存到: ${localGameDir}`);

        // 3. 【被动】设置响应拦截器
        page.on('response', (response) => {
            downloadPromises.push(
                processResponse(page, response, gameRootPathname, localGameDir, processedUrls)
            );
        });

        // 4. 导航
        console.log('--- 阶段 1: 被动抓取 (导航和监听) ---');
        console.log('正在导航到页面 (等待 "load" 事件)...');
        await page.goto(GAME_ROOT_URL, {
            waitUntil: 'load', 
        });
        console.log('页面 "load" 事件已触发。');

        console.log('额外等待 10 秒以捕获延迟加载...');
        await new Promise(r => setTimeout(r, 10000));
        console.log('额外等待结束。');

        // 5. 等待【被动】下载任务完成
        console.log(`\n--- 开始等待 ${downloadPromises.length} 个已捕获的被动下载任务 ---`);
        await Promise.allSettled(downloadPromises);
        console.log('--- 所有被动下载任务均已完成 ---');
        
        // 6. 【主动】检查并抓取缺失的文件
        await scrapeMissingFiles(page, gameRootPathname, localGameDir, processedUrls);

    } catch (e) {
        console.error(`发生致命错误: ${e.message}`);
    } finally {
        // 7. 关闭浏览器
        if (browser) {
            await browser.close();
            console.log('抓取完成，浏览器已关闭。');
        }
    }
}

// 运行脚本
scrapeGame();