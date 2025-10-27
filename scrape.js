// 【v12 升级】 引入 puppeteer-extra 和 stealth 插件
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin()); // 激活隐身模式

const fs = require("fs").promises; // 使用 fs.promises API
const path = require("path");
const { URL } = require("url");

// -------------------------------------------------
// ----------------- 全局配置区域 ------------------
// -------------------------------------------------

const GAMES_TO_SCRAPE = [
  {
    slug: "black-pink-halloween-concert",
    http_root: "589aeed18a104d34b7516dae0a3ad9c3",
  },
  // ... 在这里添加更多游戏
];

// 保持单并发和延迟以确保稳定性
const CONCURRENCY_LIMIT = 1;
const RETRY_LIMIT = 3;
const STAGGER_DELAY_MS = 10000;
const PHASE1_EXTRA_WAIT_MS = 15000;

// 【v17 修改】模式推断配置 - 现在这是动态调整的上限
const MAX_GUESSED_LEVEL_DEFAULT = 10; // 默认猜测上限

// --- 其他全局配置 ---
const DOWNLOAD_BASE_DIR = path.join(__dirname, "downloads");
const MANIFEST_FILE_EXTENSIONS = [
  ".js",
  ".json",
  ".txt",
  ".xml",
  ".atlas",
  ".css",
  ".plist",
  ".fnt",
];
const RESOURCE_REGEX =
  /(\"|')([\w\-\/\.]+\.(json|png|jpg|jpeg|mp3|ogg|wav|m4a|bin|data|bundle|txt|xml|atlas|unityweb|wasm|css|plist|fnt|svg|woff|woff2|ttf|eot|mp4|webm))\1/g;
const CSS_RESOURCE_REGEX = /url\((["']?)([^)]+?)\1\)/g;
// -------------------------------------------------
// ------------- 辅助函数 (全局) -------------------
// -------------------------------------------------

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function gotoWithRetries(page, url, logPrefix, options) {
  for (let i = 1; i <= RETRY_LIMIT; i++) {
    try {
      await page.goto(url, options);
      return true;
    } catch (e) {
      console.error(
        `${logPrefix} [失败] 导航到 ${url} 失败 (第 ${i} 次尝试): ${e.message}`
      );
      if (i < RETRY_LIMIT) {
        const waitTime = i * 2000;
        console.log(`${logPrefix} [信息] ${waitTime / 1000}秒后重试...`);
        await delay(waitTime);
      }
    }
  }
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
  const { slug: GAME_SLUG_NAME, http_root: GAME_INSTANCE_ID } = game;
  const GAME_ROOT_URL = `https://html5.gamedistribution.com/rvvASMiM/${GAME_INSTANCE_ID}/`;
  const logPrefix = `[Worker ${workerId} | ${GAME_SLUG_NAME}]`;
  const initialLevelPaths = new Set(); // 用于记录 Phase 1 路径以供 Phase 4 使用

  console.log(`${logPrefix} 任务启动... 目标: ${GAME_ROOT_URL}`);

  // --- 2. 内部化所有辅助函数 (实现隔离) ---

  // 【v17 升级】 fetchFromBrowser 现在检查 Content-Type
  async function fetchFromBrowser(page, url) {
    try {
      if (page.isClosed()) {
        throw new Error("Page was closed");
      }
      const encodedUrl = encodeURI(url);
      const result = await page.evaluate(async (url) => {
        try {
          const response = await fetch(url, { cache: "default" });
          const contentType = response.headers.get("content-type");
          if (!response.ok) {
            return {
              error: `Fetch failed with status ${response.status} for ${url}`,
              contentType,
            };
          }
          if (contentType && contentType.includes("text/html")) {
            return {
              error: `Fetch returned HTML content for ${url}`,
              contentType,
            };
          }
          const buffer = await response.arrayBuffer();
          return { data: Array.from(new Uint8Array(buffer)), contentType };
        } catch (e) {
          return { error: e.message, contentType: null };
        }
      }, encodedUrl);
      if (result.error) {
        const error = new Error(result.error);
        error.contentType = result.contentType;
        throw error;
      }
      return Buffer.from(result.data);
    } catch (e) {
      throw new Error(
        `fetchFromBrowser failed for ${url}: ${e.message}${
          e.contentType ? ` (Content-Type: ${e.contentType})` : ""
        }`
      );
    }
  }

  // 【v17 升级】 processResponse 现在检查 Content-Type 并有选择地记录路径
  async function processResponse(
    page,
    response,
    gameRootPathname,
    localGameDir,
    processedUrls,
    recordPaths = false
  ) {
    const requestUrl = response.url();
    const status = response.status();
    if (
      !requestUrl.startsWith(GAME_ROOT_URL) ||
      status >= 400 ||
      processedUrls.has(requestUrl)
    ) {
      return;
    }

    const parsedUrl = new URL(requestUrl);
    let relativePath = parsedUrl.pathname.substring(gameRootPathname.length);
    if (relativePath === "" || relativePath === "/") {
      relativePath = "index.html";
    }

    if (recordPaths && relativePath !== "index.html") {
      initialLevelPaths.add(relativePath);
    }

    processedUrls.add(requestUrl);

    const localSavePath = path.join(localGameDir, relativePath);
    let buffer;
    try {
      if (status === 304) {
        console.log(`${logPrefix} [缓存 304] ${relativePath}, 使用 fetch...`);
        buffer = await fetchFromBrowser(page, requestUrl);
      } // Checked in fetch
      else if (status >= 200 && status < 300) {
        const contentType = response.headers()["content-type"];
        if (
          contentType &&
          contentType.includes("text/html") &&
          relativePath !== "index.html"
        ) {
          console.log(`${logPrefix} [跳过-HTML] ${relativePath}`);
          return;
        }
        try {
          buffer = await response.buffer();
        } catch (e) {
          if (
            e.message.includes(
              "Request content was evicted from inspector cache"
            )
          ) {
            console.warn(
              `${logPrefix} [警告] ${relativePath} 缓存被逐出, 尝试备用 fetch...`
            );
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
        console.log(
          `${logPrefix} [成功-被动] 已保存: ${relativePath} (大小: ${buffer.length} B)`
        );
      }
    } catch (error) {
      downloadResourceErrorHandler(error, relativePath, "被动");
    } // 使用统一错误处理
  }

  // 【v17 新增】统一处理下载错误的函数
  function downloadResourceErrorHandler(error, filePath, phaseName) {
    const simplifiedPath = filePath.startsWith("http")
      ? new URL(filePath).pathname
      : filePath; // 只显示路径部分
    if (error.message.includes("Fetch failed with status 404")) {
      console.log(
        `${logPrefix} [跳过-404] ${simplifiedPath} (阶段: ${phaseName})`
      );
    } else if (error.message.includes("Fetch returned HTML content")) {
      console.log(
        `${logPrefix} [跳过-HTML] ${simplifiedPath} (阶段: ${phaseName})`
      );
    } else {
      console.error(
        `${logPrefix} [失败-${phaseName}] 抓取 ${simplifiedPath} 失败: ${error.message}`
      );
    }
  }

  async function scrapeFromUnityJson(
    page,
    gameRootPathname,
    localGameDir,
    processedUrls
  ) {
    // ... (与 v16 相同, 但下载错误使用 downloadResourceErrorHandler)
    console.log(`\n${logPrefix} --- 阶段 2: 主动检查 Unity JSON ---`);
    const jsonUrl = Array.from(processedUrls).find(
      (url) => url.startsWith(GAME_ROOT_URL) && url.endsWith(".json")
    );
    if (!jsonUrl) {
      console.log(
        `${logPrefix} [信息] 未找到 Unity .json 配置文件，跳过阶段 2。`
      );
      console.log(`${logPrefix} --- 阶段 2 完成 ---`);
      return;
    }
    const parsedJsonUrl = new URL(jsonUrl);
    let jsonRelativePath = parsedJsonUrl.pathname.substring(
      gameRootPathname.length
    );
    const localJsonPath = path.join(localGameDir, jsonRelativePath);
    let config;
    try {
      config = JSON.parse(await fs.readFile(localJsonPath, "utf-8"));
    } catch (e) {
      console.error(
        `${logPrefix} [失败] 无法读取本地JSON ${localJsonPath}: ${e.message}`
      );
      console.log(`${logPrefix} --- 阶段 2 完成 ---`);
      return;
    }
    const urlKeys = [
      "dataUrl",
      "wasmCodeUrl",
      "wasmFrameworkUrl",
      "wasmSymbolsUrl",
    ];
    const manualPromises = [];
    const buildDir = path.dirname(jsonRelativePath);
    for (const key of urlKeys) {
      const filename = config[key];
      if (!filename || typeof filename !== "string") continue;
      const fileRelPath = path.join(buildDir, filename).replace(/\\/g, "/");
      const fileFullUrl = GAME_ROOT_URL + fileRelPath;
      if (!processedUrls.has(fileFullUrl)) {
        console.log(
          `${logPrefix} [主动-JSON] 发现缺失文件 (${key}): ${fileRelPath}，正在抓取...`
        );
        processedUrls.add(fileFullUrl);
        manualPromises.push(
          (async () => {
            try {
              const buffer = await fetchFromBrowser(page, fileFullUrl);
              const localSavePath = path.join(localGameDir, fileRelPath);
              await fs.mkdir(path.dirname(localSavePath), { recursive: true });
              await fs.writeFile(localSavePath, buffer);
              console.log(
                `${logPrefix} [成功-主动] 已保存: ${fileRelPath} (大小: ${buffer.length} B)`
              );
            } catch (e) {
              downloadResourceErrorHandler(e, fileRelPath, "主动-JSON");
            }
          })()
        );
      }
    }
    if (manualPromises.length > 0) await Promise.allSettled(manualPromises);
    console.log(`${logPrefix} --- 阶段 2 完成 ---`);
  }

  // 【 v17: 深度递归扫描 + JSON 值分析 】
  async function scrapeFromManifestsRecursive(
    page,
    gameRootPathname,
    localGameDir,
    processedUrls
  ) {
    // ... (与 v16 相同, 但下载错误使用 downloadResourceErrorHandler)
    console.log(
      `\n${logPrefix} --- 阶段 3: 主动抓取(递归) JS/JSON/CSS 中的引用资源 ---`
    );
    const scannedManifests = new Set();
    let loopCount = 0;
    function findStringValues(obj, foundStrings) {
      for (const key in obj) {
        if (typeof obj[key] === "string") {
          foundStrings.add(obj[key]);
        } else if (typeof obj[key] === "object" && obj[key] !== null) {
          findStringValues(obj[key], foundStrings);
        }
      }
    }
    while (loopCount < 10) {
      loopCount++;
      const manifestsToScan = Array.from(processedUrls).filter((url) => {
        try {
          const ext = path.extname(new URL(url).pathname);
          return (
            MANIFEST_FILE_EXTENSIONS.includes(ext) && !scannedManifests.has(url)
          );
        } catch (e) {
          console.warn(`${logPrefix} [警告] 发现无效 URL: ${url}`);
          return false;
        }
      });
      if (manifestsToScan.length === 0) {
        console.log(
          `${logPrefix} [信息] (循环 ${
            loopCount - 1
          }) 未发现新的清单文件，递归扫描完成。`
        );
        break;
      }
      console.log(
        `${logPrefix} [信息] (循环 ${loopCount}) 发现 ${manifestsToScan.length} 个新清单，正在扫描...`
      );
      const newResourcesToDownload = new Map();
      for (const manifestUrl of manifestsToScan) {
        scannedManifests.add(manifestUrl);
        const parsedUrl = new URL(manifestUrl);
        let relativePath = parsedUrl.pathname.substring(
          gameRootPathname.length
        );
        const localPath = path.join(localGameDir, relativePath);
        const manifestExt = path.extname(parsedUrl.pathname);
        const isCss = manifestExt === ".css";
        const isJson = manifestExt === ".json";
        const currentRegex = isCss ? CSS_RESOURCE_REGEX : RESOURCE_REGEX;
        let content;
        try {
          content = await fs.readFile(localPath, "utf-8");
        } catch (e) {
          console.warn(
            `${logPrefix} [警告] 无法读取清单文件 ${localPath}: ${e.message}`
          );
          continue;
        }
        let match;
        currentRegex.lastIndex = 0;
        while ((match = currentRegex.exec(content)) !== null) {
          let foundPath = match[2];
          if (
            !foundPath ||
            foundPath.startsWith("data:") ||
            foundPath.startsWith("http")
          ) {
            continue;
          }
          try {
            const resolvedUrl = new URL(foundPath, manifestUrl).href;
            if (!resolvedUrl.startsWith(GAME_ROOT_URL)) {
              continue;
            }
            const fileFullUrl = resolvedUrl;
            const fileRelPath = new URL(fileFullUrl).pathname.substring(
              gameRootPathname.length
            );
            if (
              !processedUrls.has(fileFullUrl) &&
              !newResourcesToDownload.has(fileFullUrl)
            ) {
              newResourcesToDownload.set(fileFullUrl, fileRelPath);
            }
          } catch (e) {
            console.warn(
              `${logPrefix} [警告] Regex路径解析失败: ${foundPath} (来源: ${manifestUrl}) - ${e.message}`
            );
          }
        }
        if (isJson) {
          try {
            const jsonObj = JSON.parse(content);
            const potentialPaths = new Set();
            findStringValues(jsonObj, potentialPaths);
            for (const foundPath of potentialPaths) {
              if (
                !foundPath ||
                foundPath.length < 3 ||
                foundPath.startsWith("data:") ||
                foundPath.startsWith("http") ||
                !foundPath.includes(".")
              ) {
                continue;
              }
              /* 增加基础过滤 */ try {
                const resolvedUrl = new URL(foundPath, manifestUrl).href;
                if (!resolvedUrl.startsWith(GAME_ROOT_URL)) {
                  continue;
                }
                const fileFullUrl = resolvedUrl;
                const fileRelPath = new URL(fileFullUrl).pathname.substring(
                  gameRootPathname.length
                );
                if (
                  !processedUrls.has(fileFullUrl) &&
                  !newResourcesToDownload.has(fileFullUrl)
                ) {
                  console.log(
                    `${logPrefix} [信息] (JSON 值分析) 发现潜在路径: ${fileRelPath}`
                  );
                  newResourcesToDownload.set(fileFullUrl, fileRelPath);
                }
              } catch (e) {
                /* 忽略无效路径字符串 */
              }
            }
          } catch (e) {
            console.warn(
              `${logPrefix} [警告] JSON 解析失败: ${localPath} - ${e.message}`
            );
          }
        }
      }
      if (newResourcesToDownload.size > 0) {
        console.log(
          `${logPrefix} [信息] (循环 ${loopCount}) 从清单中发现 ${newResourcesToDownload.size} 个新资源，正在下载...`
        );
        const downloadPromises = [];
        for (const [
          fileFullUrl,
          fileRelPath,
        ] of newResourcesToDownload.entries()) {
          processedUrls.add(fileFullUrl);
          downloadPromises.push(
            (async () => {
              try {
                const buffer = await fetchFromBrowser(page, fileFullUrl);
                const localSavePath = path.join(localGameDir, fileRelPath);
                await fs.mkdir(path.dirname(localSavePath), {
                  recursive: true,
                });
                await fs.writeFile(localSavePath, buffer);
                console.log(
                  `${logPrefix} [成功-清单] 已保存: ${fileRelPath} (大小: ${buffer.length} B)`
                );
              } catch (e) {
                downloadResourceErrorHandler(e, fileRelPath, "清单");
              }
            })()
          );
        }
        await Promise.allSettled(downloadPromises);
      } else {
        console.log(
          `${logPrefix} [信息] (循环 ${loopCount}) 新清单中未发现新资源。`
        );
      }
    }
    if (loopCount >= 10) {
      console.warn(`${logPrefix} [警告] 递归扫描达到10次上限。`);
    }
    console.log(`${logPrefix} --- 阶段 3 完成 ---`);
  }

  // 【!!! v17 核心升级：智能模式推断 !!!】
  async function scrapeByPatternGuessing(
    page,
    gameRootPathname,
    localGameDir,
    processedUrls
  ) {
    console.log(`\n${logPrefix} --- 阶段 4: 基于模式推断抓取资源 ---`);

    const guessedResourcesToDownload = new Map();
    let maxLevelFound = 0; // 用于存储探测到的最大关卡数

    // --- A. 边界探测启发法 ---
    console.log(`${logPrefix} [信息] 正在扫描已下载资源以探测最大关卡数...`);
    const levelSelectPattern = /level(\d+)\.(png|jpg|jpeg)/i; // 查找 levelX.png 等
    const genericLevelPattern = /\/(\d+)\//; // 查找 /1/, /2/ 等路径部分

    for (const url of processedUrls) {
      const pathName = new URL(url).pathname;
      let match = pathName.match(levelSelectPattern);
      if (match && match[1]) {
        maxLevelFound = Math.max(maxLevelFound, parseInt(match[1], 10));
      }
      match = pathName.match(genericLevelPattern);
      if (match && match[1]) {
        maxLevelFound = Math.max(maxLevelFound, parseInt(match[1], 10));
      }
    }

    // 如果探测到了最大关卡，使用它，否则使用默认值
    const actualMaxGuess =
      maxLevelFound > 0 ? maxLevelFound + 1 : MAX_GUESSED_LEVEL_DEFAULT; // 加 1 作为缓冲
    console.log(
      `${logPrefix} [信息] 最大关卡探测结果: ${
        maxLevelFound > 0 ? maxLevelFound : "未探测到"
      }。将猜测上限设置为: ${actualMaxGuess}`
    );

    // --- B. 更精确的模式替换 ---
    const levelPatterns = [
      // 模式 1: 'level' + 数字 (捕获 'level' 和 数字)
      { regex: /(level)(\d+)/i, replaceIndex: 2 },
      // 模式 2: '/' + 数字 + '/' (捕获 '/' 数字 '/')
      { regex: /(\/)(\d+)(\/)/, replaceIndex: 2 },
      // 模式 3: '_' + 数字 + '_' 或 '.' (捕获 '_' 数字 '_')
      { regex: /(_)(\d+)(_|\.)/, replaceIndex: 2 },
      // 模式 4: 'scene' + 数字 (捕获 'scene' 和 数字)
      { regex: /(scene)(\d+)/i, replaceIndex: 2 },
    ];

    for (const initialPath of initialLevelPaths) {
      for (const { regex, replaceIndex } of levelPatterns) {
        const match = initialPath.match(regex);

        // 确保捕获组存在且为数字
        if (
          match &&
          match[replaceIndex] &&
          !isNaN(parseInt(match[replaceIndex], 10))
        ) {
          const currentLevel = parseInt(match[replaceIndex], 10);
          // 只基于数字为 1 或 0 的路径进行推断
          if (currentLevel === 1 || currentLevel === 0) {
            for (
              let nextLevel = currentLevel + 1;
              nextLevel <= actualMaxGuess;
              nextLevel++
            ) {
              // **智能替换**: 只替换捕获到的数字部分
              let partIndex = 0;
              const guessedPath = initialPath.replace(regex, (...args) => {
                let replacedString = "";
                // 重新组合匹配前的部分 + 新数字 + 匹配后的部分
                for (let i = 1; i < args.length - 2; i++) {
                  // 忽略 fullMatch, offset, string
                  if (i === replaceIndex) {
                    replacedString += nextLevel; // 替换数字
                  } else {
                    replacedString += args[i]; // 保留其他捕获组 (如 'level', '/', '_')
                  }
                }
                return replacedString;
              });

              // 避免因替换错误导致路径不变
              if (guessedPath === initialPath) continue;

              const guessedFullUrl = GAME_ROOT_URL + guessedPath;

              if (
                !processedUrls.has(guessedFullUrl) &&
                !guessedResourcesToDownload.has(guessedFullUrl)
              ) {
                console.log(
                  `${logPrefix} [推断] 基于 ${initialPath} 猜测 -> ${guessedPath}`
                );
                guessedResourcesToDownload.set(guessedFullUrl, guessedPath);
              }
            }
            // 假设一个路径只属于一种关卡模式
            break;
          }
        }
      }
    }

    // --- C. 下载猜测的资源 ---
    if (guessedResourcesToDownload.size > 0) {
      console.log(
        `${logPrefix} [信息] 推断出 ${guessedResourcesToDownload.size} 个潜在资源，正在尝试下载...`
      );
      const downloadPromises = [];
      for (const [
        fileFullUrl,
        fileRelPath,
      ] of guessedResourcesToDownload.entries()) {
        processedUrls.add(fileFullUrl); // 标记为已尝试
        downloadPromises.push(
          (async () => {
            try {
              const buffer = await fetchFromBrowser(page, fileFullUrl);
              const localSavePath = path.join(localGameDir, fileRelPath);
              await fs.mkdir(path.dirname(localSavePath), { recursive: true });
              await fs.writeFile(localSavePath, buffer);
              console.log(
                `${logPrefix} [成功-推断] 已保存: ${fileRelPath} (大小: ${buffer.length} B)`
              );
            } catch (e) {
              downloadResourceErrorHandler(e, fileRelPath, "推断");
            }
          })()
        );
      }
      await Promise.allSettled(downloadPromises);
    } else {
      console.log(`${logPrefix} [信息] 未能从初始路径推断出新的资源模式。`);
    }
    console.log(`${logPrefix} --- 阶段 4 完成 ---`);
  }

  async function scrapeMetadata(page, url) {
    // ... (与 v16 相同)
    console.log(`${logPrefix} 正在从 ${url} 抓取元数据...`);
    try {
      await gotoWithRetries(page, url, logPrefix, {
        waitUntil: "load",
        timeout: 120000,
      });
      const metadata = await page.evaluate(() => {
        const findContentByHeading = (text) => {
          try {
            const heading = Array.from(document.querySelectorAll("h3")).find(
              (h) => h.innerText.trim().toLowerCase() === text.toLowerCase()
            );
            return heading?.nextElementSibling?.innerText.trim() || null;
          } catch (e) {
            return null;
          }
        };
        const gameName =
          document
            .querySelector("span:has(strong.font-semibold) > strong")
            ?.innerText.trim() || null;
        const publishedBy =
          document.querySelector('a[href*="company="]')?.innerText.trim() ||
          null;
        const description = findContentByHeading("description");
        const instructions = findContentByHeading("instructions");
        const tags = Array.from(
          document.querySelectorAll("div.tags > span.tag")
        ).map((s) => s.innerText.trim());
        const category =
          document.querySelector('a[href*="/categories/"]')?.innerText.trim() ||
          null;
        let imageUrl =
          document.querySelector('meta[property="og:image"]')?.content || null;
        if (!imageUrl) {
          imageUrl =
            document.querySelector(
              'div.games_gameThumnailImage__eM2Tb img[alt*="-512x512"]'
            )?.src || null;
        }
        if (!imageUrl) {
          imageUrl =
            document.querySelector("div.games_gameThumnailImage__eM2Tb img")
              ?.src || null;
        }
        return {
          gameName,
          description,
          instructions,
          category,
          publishedBy,
          tags,
          imageUrl,
        };
      });
      console.log(`${logPrefix} [成功-元数据] 已抓取元数据。`);
      return metadata;
    } catch (e) {
      console.error(`${logPrefix} [失败-元数据] 抓取元数据失败: ${e.message}`);
      return {
        gameName: null,
        description: null,
        instructions: null,
        category: null,
        publishedBy: null,
        tags: [],
        imageUrl: null,
      };
    }
  }

  async function scrapeImage(page, imageUrl, localGameDir) {
    // ... (与 v16 相同, 但下载错误使用 downloadResourceErrorHandler)
    if (!imageUrl) {
      console.log(
        `${logPrefix} [信息] 未在元数据页面找到 imageUrl，跳过缩略图下载。`
      );
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
      downloadResourceErrorHandler(e, imageUrl, "图片");
    }
  }

  async function saveMetadata(localGameDir, metadata) {
    // ... (与 v16 相同)
    if (!metadata.gameName && !metadata.description) {
      console.log(
        `${logPrefix} [信息] 未抓取到元数据，跳过保存 game_info.txt。`
      );
      return;
    }
    const content = `### 游戏名称 (Game Title) ###\n${
      metadata.gameName || "N/A"
    }\n### 发行商 (Published by) ###\n${
      metadata.publishedBy || "N/A"
    }\n### 描述 (DESCRIPTION) ###\n${
      metadata.description || "N/A"
    }\n### 操作指南 (INSTRUCTIONS) ###\n${
      metadata.instructions || "N/A"
    }\n### 分类 (Category) ###\n${
      metadata.category || "N/A"
    }\n### 标签 (Tags) ###\n${metadata.tags?.join(", ") || "N/A"}\n`;
    try {
      const savePath = path.join(localGameDir, "game_info.txt");
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
    browser = await puppeteer.launch({
      headless: true,
      protocolTimeout: 180000,
    });

    // 2. 解析 URL 和路径
    const gameRootParsed = new URL(GAME_ROOT_URL);
    const gameRootPathname = gameRootParsed.pathname;
    const LANDING_PAGE_URL = `https://gamedistribution.com/games/${GAME_SLUG_NAME}`;
    const localGameDir = path.join(DOWNLOAD_BASE_DIR, GAME_INSTANCE_ID);
    console.log(`${logPrefix} 资源将保存到: ${localGameDir}`);

    // --- 阶段 0: 抓取元数据和图片 ---
    console.log(`\n${logPrefix} --- 阶段 0: 抓取元数据 (Metadata) ---`);
    const metadataPage = await browser.newPage();
    const metadata = await scrapeMetadata(metadataPage, LANDING_PAGE_URL);
    await saveMetadata(localGameDir, metadata);
    await scrapeImage(metadataPage, metadata.imageUrl, localGameDir);
    await metadataPage.close();
    console.log(`${logPrefix} --- 阶段 0 完成 ---`);

    // --- 阶段 1: 被动抓取 (导航和监听) ---
    console.log(`\n${logPrefix} --- 阶段 1: 被动抓取 (导航和监听) ---`);
    const gamePage = await browser.newPage();
    gamePage.setDefaultNavigationTimeout(120000);
    gamePage.on("response", (response) => {
      downloadPromises.push(
        processResponse(
          gamePage,
          response,
          gameRootPathname,
          localGameDir,
          processedUrls,
          true
        ) // 记录路径
      );
    });

    await gotoWithRetries(gamePage, GAME_ROOT_URL, logPrefix, {
      waitUntil: "load",
      timeout: 120000,
    });

    console.log(`${logPrefix} 页面 "load" 事件已触发。`);
    console.log(
      `${logPrefix} 额外等待 ${PHASE1_EXTRA_WAIT_MS / 1000} 秒以捕获延迟加载...`
    );
    await delay(PHASE1_EXTRA_WAIT_MS);
    console.log(`${logPrefix} 额外等待结束。`);

    console.log(
      `\n${logPrefix} --- 等待 ${downloadPromises.length} 个已捕获的被动下载任务 ---`
    );
    await Promise.allSettled(downloadPromises);
    console.log(`${logPrefix} --- 阶段 1 (被动) 完成 ---`);

    // --- 阶段 2: 主动 Unity JSON 抓取 ---
    await scrapeFromUnityJson(
      gamePage,
      gameRootPathname,
      localGameDir,
      processedUrls
    );

    // --- 阶段 3: 深度递归清单抓取 ---
    await scrapeFromManifestsRecursive(
      gamePage,
      gameRootPathname,
      localGameDir,
      processedUrls
    );

    // --- 阶段 4: 模式推断 ---
    // 【!!! v17 修复 !!!】正确传递 gamePage
    await scrapeByPatternGuessing(
      gamePage,
      gameRootPathname,
      localGameDir,
      processedUrls
    );
  } catch (e) {
    console.error(`${logPrefix} 发生致命错误: ${e.message}`);
  } finally {
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
  console.log(
    `--- 任务总数: ${GAMES_TO_SCRAPE.length} | 并发数: ${CONCURRENCY_LIMIT} ---`
  );

  const queue = [...GAMES_TO_SCRAPE];
  const runningTasks = [];
  let workerId = 0;

  function startNextTask() {
    if (queue.length > 0) {
      workerId++;
      const game = queue.shift();
      console.log(`[Manager] 分配任务 ${game.slug} (ID: ${workerId})`);

      const taskPromise = scrapeGame(game, workerId)
        .catch((err) => {
          console.error(
            `[Manager] Worker ${workerId} (${game.slug}) 遭遇未处理的严重错误:`,
            err
          );
        })
        .finally(() => {
          runningTasks.splice(runningTasks.indexOf(taskPromise), 1);
        });

      runningTasks.push(taskPromise);
      return taskPromise;
    }
    return null;
  }

  for (let i = 0; i < CONCURRENCY_LIMIT && queue.length > 0; i++) {
    startNextTask();
    if (i < CONCURRENCY_LIMIT - 1 && queue.length > 0) {
      console.log(`[Manager] 等待 ${STAGGER_DELAY_MS}ms 错峰...`);
      await delay(STAGGER_DELAY_MS);
    }
  }

  while (queue.length > 0 || runningTasks.length > 0) {
    if (runningTasks.length < CONCURRENCY_LIMIT && queue.length > 0) {
      console.log(
        `[Manager] 任务完成，有空闲槽位。等待 ${STAGGER_DELAY_MS}ms 错峰...`
      );
      await delay(STAGGER_DELAY_MS);
      startNextTask();
    } else if (runningTasks.length > 0) {
      await Promise.race(runningTasks);
    }
  }

  console.log("--- 所有游戏均已处理完毕 ---");
}

// -------------------------------------------------
// -------------------  运行脚本 -------------------
// -------------------------------------------------
runPool();
