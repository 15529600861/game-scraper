// 引入所需的库
const puppeteer = require('puppeteer');
const fs = require('fs').promises; // 使用 fs.promises API
const path = require('path');
const { URL } = require('url');

// -------------------------------------------------
// 配置区域
// -------------------------------------------------

// 1. 输入你的游戏根路径 (确保以 '/' 结尾)
const GAME_ROOT_URL = 'https://html5.gamedistribution.com/rvvASMiM/8cfbb6f4272b438fa38cb882cc071091/';

// 2. 设置本地保存的根目录
const DOWNLOAD_BASE_DIR = path.join(__dirname, 'downloads');

// -------------------------------------------------

/**
 * 主执行函数
 */
async function scrapeGame() {
    console.log(`项目启动... 目标: ${GAME_ROOT_URL}`);

    // 1. 启动浏览器
    const browser = await puppeteer.launch();
    const page = await browser.newPage();

    // 2. 解析根 URL，用于后续计算相对路径
    const gameRootParsed = new URL(GAME_ROOT_URL);
    const gameRootPathname = gameRootParsed.pathname;

    // 3. 根据游戏 URL 的一部分创建唯一的下载目录
    //    例如: .../8cfbb6f4272b438fa38cb882cc071091/ -> ./downloads/8cfbb6f4272b438fa38cb882cc071091
    const gameId = gameRootPathname.split('/').filter(Boolean).pop(); // 获取路径的最后一部分
    const localGameDir = path.join(DOWNLOAD_BASE_DIR, gameId);
    console.log(`资源将保存到: ${localGameDir}`);

    // 4. 关键：设置响应拦截器
    //    当页面发出任何网络请求并收到响应时，此事件将被触发
    page.on('response', async (response) => {
        const requestUrl = response.url();

        // 5. 只保存来自我们目标游戏目录的资源
        if (!requestUrl.startsWith(GAME_ROOT_URL)) {
            return;
        }

        // 6. 计算相对路径和本地保存路径
        const parsedUrl = new URL(requestUrl);
        let relativePath = parsedUrl.pathname.substring(gameRootPathname.length);
        
        // 如果是根路径 (例如 '.../'), 我们将其保存为 index.html
        if (relativePath === '' || relativePath === '/') {
            relativePath = 'index.html';
        }

        const localSavePath = path.join(localGameDir, relativePath);

        // 7. 创建保存文件所需的目录结构
        const localDir = path.dirname(localSavePath);
        await fs.mkdir(localDir, { recursive: true });

        // 8. 获取响应内容 (buffer) 并写入文件
        try {
            const buffer = await response.buffer();
            await fs.writeFile(localSavePath, buffer);
            console.log(`[成功] 已保存: ${relativePath}`);
        } catch (e) {
            console.error(`[失败] 保存 ${relativePath} 时出错: ${e.message}`);
        }
    });

    // 9. 导航到游戏页面
    console.log('正在导航到页面并等待资源加载...');
    try {
        await page.goto(GAME_ROOT_URL, {
            waitUntil: 'networkidle0', // 等待直到网络空闲 (大多数资源已加载)
            timeout: 60000 // 60秒超时
        });

        // 额外等待一段时间，以防有延迟加载的资源 (例如 BGM)
        console.log('网络已空闲，额外等待 10 秒...');
        await new Promise(r => setTimeout(r, 10000)); 

    } catch (e) {
        console.error(`页面导航失败: ${e.message}`);
    }

    // 10. 关闭浏览器
    await browser.close();
    console.log('抓取完成。');
}

// 运行脚本
scrapeGame();