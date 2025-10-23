// 引入所需的库
const puppeteer = require('puppeteer');
const fs = require('fs').promises; // 使用 fs.promises API
const path = require('path');
const { URL } = require('url');

// -------------------------------------------------
// 配置区域
// -------------------------------------------------
// 【!!! 已修正这里的 URL !!!】
const GAME_ROOT_URL = 'https://html5.gamedistribution.com/rvvASMiM/8cfbb6f4272b438fa38cb882cc071091/'; 
const DOWNLOAD_BASE_DIR = path.join(__dirname, 'downloads');

// -------------------------------------------------

/**
 * 辅助函数：在浏览器上下文中 fetch 资源
 */
async function fetchFromBrowser(page, url) {
    try {
        // 增加 page.isClosed() 检查
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
 * 【核心】处理单个响应的异步函数
 */
async function processResponse(page, response, gameRootPathname, localGameDir, processedUrls) {
    const requestUrl = response.url();
    const status = response.status();

    // 5. 过滤
    if (!requestUrl.startsWith(GAME_ROOT_URL) || status >= 400 || processedUrls.has(requestUrl)) {
        return; // 静默返回
    }
    processedUrls.add(requestUrl); // 标记为已处理

    // 6. 计算相对路径
    const parsedUrl = new URL(requestUrl);
    let relativePath = parsedUrl.pathname.substring(gameRootPathname.length);
    if (relativePath === '' || relativePath === '/') {
        relativePath = 'index.html';
    }
    const localSavePath = path.join(localGameDir, relativePath);

    let buffer;
    try {
        // 7. 获取 Buffer
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
                    throw e; // 抛出其他 buffer 错误
                }
            }
        } else {
            return; // 忽略 301/302 等
        }

        // 8. 创建目录并写入文件
        if (buffer) {
            await fs.mkdir(path.dirname(localSavePath), { recursive: true });
            await fs.writeFile(localSavePath, buffer);
            console.log(`[成功] 已保存: ${relativePath} (大小: ${buffer.length} B)`);
        }
    } catch (error) {
        // 捕获所有获取/写入过程中的失败
        console.error(`[失败] 处理 ${relativePath} 时出错: ${error.message}`);
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
        const page = await browser.newPage();
        
        // 设置一个较长的默认超时时间 (例如 2 分钟)，防止页面本身加载缓慢
        page.setDefaultNavigationTimeout(120000); 

        // 2. 解析 URL
        const gameRootParsed = new URL(GAME_ROOT_URL);
        const gameRootPathname = gameRootParsed.pathname;
        const gameId = gameRootPathname.split('/').filter(Boolean).pop();
        const localGameDir = path.join(DOWNLOAD_BASE_DIR, gameId);
        console.log(`资源将保存到: ${localGameDir}`);

        // 3. 关键：设置响应拦截器
        page.on('response', (response) => {
            downloadPromises.push(
                processResponse(page, response, gameRootPathname, localGameDir, processedUrls)
            );
        });

        // 4. 导航到页面
        console.log('正在导航到页面 (等待 "load" 事件)...');
        await page.goto(GAME_ROOT_URL, {
            waitUntil: 'load', 
        });
        console.log('页面 "load" 事件已触发。');

        // 额外等待一段时间，以捕获由 JS 触发的【延迟加载】
        console.log('额外等待 10 秒以捕获延迟加载...');
        await new Promise(r => setTimeout(r, 10000));
        console.log('额外等待结束。');

        // 5. 【核心修改】等待所有下载任务完成
        console.log(`\n--- 开始等待 ${downloadPromises.length} 个已捕获的下载任务 ---`);
        
        const results = await Promise.allSettled(downloadPromises);
        console.log('--- 所有下载任务均已完成 ---');
        
        const failedTasks = results.filter(r => r.status === 'rejected');
        if (failedTasks.length > 0) {
            console.warn(`\n[警告] 有 ${failedTasks.length} 个任务在执行中失败 (详情见上方日志)。`);
        }

    } catch (e) {
        // 捕获导航或浏览器启动时的致命错误
        console.error(`发生致命错误: ${e.message}`);
    } finally {
        // 6. 关闭浏览器
        if (browser) {
            await browser.close();
            console.log('抓取完成，浏览器已关闭。');
        }
    }
}

// 运行脚本
scrapeGame();