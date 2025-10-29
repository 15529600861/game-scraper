// 【v12 升级】 引入 puppeteer-extra 和 stealth 插件
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin()); // 激活隐身模式

const fs = require("fs").promises; // 使用 fs.promises API
const path = require("path");
const { URL } = require("url");
// 【v18 新增】 用于清理文件名的库
const sanitize = require("sanitize-filename");

// -------------------------------------------------
// ----------------- 全局配置区域 ------------------
// -------------------------------------------------

const GAMES_TO_SCRAPE = [
    // 注意： slug是游戏的标识符，http_root是游戏的http根目录，folder_name是下载的文件夹名称
    // pg: slug: hello!-world 对应的 folder_name: hello-world
    //  { slug: "love-archer", http_root: "dc39086fbc2c44108269b124e0ceb78b",folder_name: "love-archer" },
    { slug: "bomb-head-hot-potato", http_root: "e903dd30b25b4b3eb53640f7bb1edfe1",folder_name: "bomb-head-hot-potato" },
  //  {
  //     slug: "mega-lamba-ramp",
  //     http_root: "08f7196aa8c241dc81f27f118fa1f61e",
  // }, // 存在问题
  // ... 在这里添加更多游戏
];

// 保持单并发和延迟以确保稳定性
const CONCURRENCY_LIMIT = 1;
const RETRY_LIMIT = 3;
const STAGGER_DELAY_MS = 10000;
const PHASE1_EXTRA_WAIT_MS = 15000;

// 模式推断配置
const MAX_GUESSED_LEVEL_DEFAULT = 10;

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
// v18 用于检查非法字符
const INVALID_PATH_CHARS_REGEX = /[<>:"\/\\|?*]/;
// 【v19 新增】用于检查是否只有扩展名
const ONLY_EXTENSION_REGEX = /^\.[a-zA-Z0-9]+$/;
// 【v19 新增】用于检查是否仍包含编码字符
const REMAINING_ENCODING_REGEX = /%[0-9A-Fa-f]{2}/;
// 【v19 新增】文件名最大长度
const MAX_FILENAME_LENGTH = 200;
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
  const { slug: ORIGINAL_GAME_SLUG_NAME, http_root: GAME_INSTANCE_ID,folder_name: DOWNLOAD_FOLDER_NAME } = game;
  const SANITIZED_GAME_SLUG_NAME = ORIGINAL_GAME_SLUG_NAME.replace(
    /[^a-zA-Z0-9\-]/g,
    ""
  );
  const GAME_ROOT_URL = `https://html5.gamedistribution.com/rvvASMiM/${GAME_INSTANCE_ID}/`;
  const LANDING_PAGE_URL = `https://gamedistribution.com/games/${ORIGINAL_GAME_SLUG_NAME}`;
  const logPrefix = `[Worker ${workerId} | ${ORIGINAL_GAME_SLUG_NAME}]`;
  const initialLevelPaths = new Set();
  const skippedFilesLog = []; // 【v19 新增】用于记录跳过的文件

  console.log(`${logPrefix} 任务启动... 目标: ${GAME_ROOT_URL}`);
  console.log(
    `${logPrefix} 清理后 Slug: ${SANITIZED_GAME_SLUG_NAME}, 元数据 URL: ${LANDING_PAGE_URL}`
  );

  // --- 2. 内部化所有辅助函数 (实现隔离) ---

  // 【v19 升级】 fetchFromBrowser 严格检查 Content-Type
  async function fetchFromBrowser(page, url) {
    try {
      if (page.isClosed()) {
        throw new Error("Page was closed");
      }
      const encodedUrl = encodeURI(url); // 仍然发送编码后的 URL
      const result = await page.evaluate(async (url) => {
        try {
          const response = await fetch(url, { cache: "default" });
          const contentType = response.headers.get("content-type") || ""; // 确保 contentType 存在
          if (!response.ok) {
            return {
              error: `Fetch failed with status ${response.status} for ${url}`,
              contentType,
            };
          }
          // **严格检查HTML**: 只要 Content-Type 包含 'text/html' 就报错 (除非原始 URL 指向 .html)
          const isHtml = contentType.includes("text/html");
          const expectsHtml =
            url.toLowerCase().endsWith(".html") || url.endsWith("/"); // 根路径通常是 HTML
          if (isHtml && !expectsHtml) {
            return {
              error: `Fetch returned HTML content for non-HTML URL ${url}`,
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

  // 【v19 升级】统一处理下载错误的函数
  function downloadResourceErrorHandler(
    error,
    originalUrlOrPath,
    phaseName,
    skipReason = null
  ) {
    let displayPath = originalUrlOrPath;
    // 尝试解码URL路径使其更易读
    try {
      if (originalUrlOrPath.startsWith("http")) {
        const urlObj = new URL(originalUrlOrPath);
        // 避免解码查询参数等
        displayPath = decodeURIComponent(urlObj.pathname);
      } else {
        displayPath = decodeURIComponent(originalUrlOrPath);
      }
    } catch (e) {
      /* 如果解码失败，就用原始路径 */
    }

    // 移除开头的 gameRootPathname (如果存在)
    const gameRootPathname = new URL(GAME_ROOT_URL).pathname;
    if (displayPath.startsWith(gameRootPathname)) {
      displayPath = displayPath.substring(gameRootPathname.length);
    }

    if (error?.message?.includes("Fetch failed with status 404")) {
      console.log(
        `${logPrefix} [跳过-404] ${displayPath} (阶段: ${phaseName})`
      );
    } else if (error?.message?.includes("Fetch returned HTML content")) {
      console.log(
        `${logPrefix} [跳过-HTML] ${displayPath} (阶段: ${phaseName})`
      );
      // 将 HTML 错误也记录到跳过列表
      skippedFilesLog.push(
        `[${phaseName}] ${originalUrlOrPath} (原因: 返回HTML内容)`
      );
    } else if (skipReason) {
      console.warn(
        `${logPrefix} [跳过-${skipReason}] ${displayPath} (原始URL/路径: ${originalUrlOrPath}) (阶段: ${phaseName})`
      );
      skippedFilesLog.push(
        `[${phaseName}] ${originalUrlOrPath} (原因: ${skipReason})`
      );
    } else {
      console.error(
        `${logPrefix} [失败-${phaseName}] 处理 ${displayPath} 失败: ${
          error?.message || "未知错误"
        }`
      );
      skippedFilesLog.push(
        `[${phaseName}] ${originalUrlOrPath} (原因: ${
          error?.message || "未知错误"
        })`
      );
    }
  }

  // 【v19 核心升级】 路径解码与验证
  function getSafeRelativePath(
    originalRelativePath,
    originalUrl,
    phaseName,
    logPrefix
  ) {
    let decodedPath;
    try {
      // 1. 解码
      decodedPath = decodeURIComponent(originalRelativePath);
    } catch (e) {
      downloadResourceErrorHandler(e, originalUrl, phaseName, "路径解码失败");
      return null; // 解码失败，直接跳过
    }

    // 2. 验证解码结果
    const basename = path.basename(decodedPath);
    // 检查路径本身的有效性，而不是 URL 编码前的原始路径
    if (
      decodedPath.length === 0 || // 路径不能为空
      decodedPath.length > MAX_FILENAME_LENGTH || // 过长
      INVALID_PATH_CHARS_REGEX.test(decodedPath.replace(/\//g, "")) || // 包含非法字符
      REMAINING_ENCODING_REGEX.test(decodedPath) || // 仍然包含编码 (解码不完全?)
      (ONLY_EXTENSION_REGEX.test(basename) && basename.length > 1) // 只有扩展名
    ) {
      // 对于 index.html，即使路径为空也要允许
      if (
        originalRelativePath === "index.html" &&
        decodedPath === "index.html"
      ) {
        // index.html 通过验证
      } else {
        downloadResourceErrorHandler(
          null,
          originalUrl,
          phaseName,
          "无效文件名/路径"
        );
        return null; // 验证失败，跳过
      }
    }

    // 3. 清理（主要处理空格等，并确保替换掉所有在Windows中非法的字符）
    // sanitize 会处理掉 < > : " / \ | ? * 以及控制字符
    const pathSegments = decodedPath
      .split("/")
      .map((segment) => sanitize(segment, { replacement: "_" })); // 使用下划线替换非法字符
    const sanitizedPath = pathSegments.join("/");

    if (decodedPath !== sanitizedPath) {
      console.warn(
        `${logPrefix} [警告] (阶段: ${phaseName}) 清理路径: "${decodedPath}" -> "${sanitizedPath}"`
      );
    }

    return sanitizedPath; // 返回安全的文件系统路径
  }

  // 【v19 升级】processResponse 使用 getSafeRelativePath
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
    let originalRelativePath = parsedUrl.pathname.substring(
      gameRootPathname.length
    );
    if (originalRelativePath === "" || originalRelativePath === "/") {
      originalRelativePath = "index.html";
    }

    if (recordPaths && originalRelativePath !== "index.html") {
      initialLevelPaths.add(originalRelativePath);
    }

    processedUrls.add(requestUrl);

    // 【v19 调用】 获取安全路径
    const safeRelativePath = getSafeRelativePath(
      originalRelativePath,
      requestUrl,
      "被动",
      logPrefix
    );
    if (!safeRelativePath) return; // 如果路径无效，则停止处理

    const localSavePath = path.join(localGameDir, safeRelativePath);
    let buffer;
    try {
      if (status === 304) {
        console.log(
          `${logPrefix} [缓存 304] ${safeRelativePath}, 使用 fetch...`
        );
        buffer = await fetchFromBrowser(page, requestUrl);
      } // Checked in fetch
      else if (status >= 200 && status < 300) {
        const contentType = response.headers()["content-type"] || ""; // 确保存在
        // **严格检查HTML**
        if (
          contentType.includes("text/html") &&
          safeRelativePath !== "index.html"
        ) {
          downloadResourceErrorHandler(null, requestUrl, "被动", "HTML内容");
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
              `${logPrefix} [警告] ${safeRelativePath} 缓存被逐出, 尝试备用 fetch...`
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
        try {
          await fs.mkdir(path.dirname(localSavePath), { recursive: true });
          await fs.writeFile(localSavePath, buffer);
          console.log(
            `${logPrefix} [成功-被动] 已保存: ${safeRelativePath} (大小: ${buffer.length} B)`
          );
        } catch (writeError) {
          console.error(
            `${logPrefix} [失败-文件系统] 无法写入 "${localSavePath}": ${writeError.message}`
          );
          skippedFilesLog.push(
            `[被动] ${requestUrl} (原因: 文件系统写入失败 - ${
              writeError.code || writeError.message
            })`
          );
        }
      }
    } catch (fetchError) {
      downloadResourceErrorHandler(fetchError, requestUrl, "被动");
    }
  }

  // 【v19 升级】 统一使用 downloadAndSaveResource
  async function downloadAndSaveResource(
    page,
    fileFullUrl,
    originalFileRelPath,
    localGameDir,
    phaseName
  ) {
    // 【v19 调用】 获取安全路径
    const safeRelativePath = getSafeRelativePath(
      originalFileRelPath,
      fileFullUrl,
      phaseName,
      logPrefix
    );
    if (!safeRelativePath) return; // 如果路径无效，则不下载

    try {
      const buffer = await fetchFromBrowser(page, fileFullUrl); // fetchFromBrowser 内部会检查 Content-Type
      const localSavePath = path.join(localGameDir, safeRelativePath);

      try {
        await fs.mkdir(path.dirname(localSavePath), { recursive: true });
        await fs.writeFile(localSavePath, buffer);
        console.log(
          `${logPrefix} [成功-${phaseName}] 已保存: ${safeRelativePath} (大小: ${buffer.length} B)`
        );
      } catch (writeError) {
        console.error(
          `${logPrefix} [失败-文件系统] 无法写入 "${localSavePath}": ${writeError.message}`
        );
        skippedFilesLog.push(
          `[${phaseName}] ${fileFullUrl} (原因: 文件系统写入失败 - ${
            writeError.code || writeError.message
          })`
        );
      }
    } catch (fetchError) {
      downloadResourceErrorHandler(fetchError, fileFullUrl, phaseName); // 使用原始 URL 报告错误
    }
  }

  async function scrapeFromUnityJson(
    page,
    gameRootPathname,
    localGameDir,
    processedUrls
  ) {
    // 【v19 修改】 使用 downloadAndSaveResource
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
          downloadAndSaveResource(
            page,
            fileFullUrl,
            fileRelPath,
            localGameDir,
            "主动-JSON"
          )
        );
      }
    }
    if (manualPromises.length > 0) await Promise.allSettled(manualPromises);
    console.log(`${logPrefix} --- 阶段 2 完成 ---`);
  }

  // 【 v19: 深度递归扫描 + JSON 值分析 + 路径验证 】
  async function scrapeFromManifestsRecursive(
    page,
    gameRootPathname,
    localGameDir,
    processedUrls
  ) {
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
              // 【v19 升级】更严格的 JSON 路径验证 + 解码检查
              if (
                !foundPath ||
                foundPath.length < 3 ||
                foundPath.length > MAX_FILENAME_LENGTH || // 使用常量
                foundPath.startsWith("data:") ||
                foundPath.startsWith("http") ||
                !foundPath.includes(".") || // 必须包含扩展名分隔符
                ONLY_EXTENSION_REGEX.test(path.basename(foundPath)) || // 不能只有扩展名
                INVALID_PATH_CHARS_REGEX.test(foundPath.replace(/\//g, ""))
              ) {
                continue;
              }
              let decodedPath;
              try {
                decodedPath = decodeURIComponent(foundPath);
                if (
                  decodedPath.length > MAX_FILENAME_LENGTH ||
                  INVALID_PATH_CHARS_REGEX.test(
                    decodedPath.replace(/\//g, "")
                  ) ||
                  REMAINING_ENCODING_REGEX.test(decodedPath)
                ) {
                  // 如果解码后仍然有问题，记录并跳过
                  downloadResourceErrorHandler(
                    null,
                    manifestUrl + " -> " + foundPath,
                    "清单",
                    "JSON值无效/乱码"
                  );
                  continue;
                }
              } catch (decodeError) {
                downloadResourceErrorHandler(
                  decodeError,
                  manifestUrl + " -> " + foundPath,
                  "清单",
                  "JSON值解码失败"
                );
                continue;
              } // 解码失败，跳过

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
                  // 不需要在这里 log 了，downloadAndSaveResource 会 log
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
      // --- 下载 ---
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
            downloadAndSaveResource(
              page,
              fileFullUrl,
              fileRelPath,
              localGameDir,
              "清单"
            )
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

  // 【v17: 智能模式推断】
  async function scrapeByPatternGuessing(
    page,
    gameRootPathname,
    localGameDir,
    processedUrls
  ) {
    // 【v19 修改】 使用 downloadAndSaveResource
    console.log(`\n${logPrefix} --- 阶段 4: 基于模式推断抓取资源 ---`);
    const guessedResourcesToDownload = new Map();
    let maxLevelFound = 0;
    console.log(`${logPrefix} [信息] 正在扫描已下载资源以探测最大关卡数...`);
    const levelSelectPattern = /level(\d+)\.(png|jpg|jpeg)/i;
    const genericLevelPattern = /\/(\d+)\//;
    for (const url of processedUrls) {
      try {
        const pathName = new URL(url).pathname;
        let match = pathName.match(levelSelectPattern);
        if (match && match[1]) {
          maxLevelFound = Math.max(maxLevelFound, parseInt(match[1], 10));
        }
        match = pathName.match(genericLevelPattern);
        if (match && match[1]) {
          maxLevelFound = Math.max(maxLevelFound, parseInt(match[1], 10));
        }
      } catch (e) {
        /* 忽略无效URL */
      }
    }
    const actualMaxGuess =
      maxLevelFound > 0 ? maxLevelFound + 1 : MAX_GUESSED_LEVEL_DEFAULT;
    console.log(
      `${logPrefix} [信息] 最大关卡探测结果: ${
        maxLevelFound > 0 ? maxLevelFound : "未探测到"
      }。将猜测上限设置为: ${actualMaxGuess}`
    );
    const levelPatterns = [
      { regex: /(level)(\d+)/i, replaceIndex: 2 },
      { regex: /(\/)(\d+)(\/)/, replaceIndex: 2 },
      { regex: /(_)(\d+)(_|\.)/, replaceIndex: 2 },
      { regex: /(scene)(\d+)/i, replaceIndex: 2 },
    ];
    for (const initialPath of initialLevelPaths) {
      for (const { regex, replaceIndex } of levelPatterns) {
        const match = initialPath.match(regex);
        if (
          match &&
          match[replaceIndex] &&
          !isNaN(parseInt(match[replaceIndex], 10))
        ) {
          const currentLevel = parseInt(match[replaceIndex], 10);
          if (currentLevel === 1 || currentLevel === 0) {
            for (
              let nextLevel = currentLevel + 1;
              nextLevel <= actualMaxGuess;
              nextLevel++
            ) {
              let partIndex = 0;
              const guessedPath = initialPath.replace(regex, (...args) => {
                let replacedString = "";
                for (let i = 1; i < args.length - 2; i++) {
                  if (i === replaceIndex) {
                    replacedString += nextLevel;
                  } else {
                    replacedString += args[i];
                  }
                }
                return replacedString;
              });
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
            break;
          }
        }
      }
    }
    if (guessedResourcesToDownload.size > 0) {
      console.log(
        `${logPrefix} [信息] 推断出 ${guessedResourcesToDownload.size} 个潜在资源，正在尝试下载...`
      );
      const downloadPromises = [];
      for (const [
        fileFullUrl,
        fileRelPath,
      ] of guessedResourcesToDownload.entries()) {
        processedUrls.add(fileFullUrl);
        downloadPromises.push(
          downloadAndSaveResource(
            page,
            fileFullUrl,
            fileRelPath,
            localGameDir,
            "推断"
          )
        );
      }
      await Promise.allSettled(downloadPromises);
    } else {
      console.log(`${logPrefix} [信息] 未能从初始路径推断出新的资源模式。`);
    }
    console.log(`${logPrefix} --- 阶段 4 完成 ---`);
  }

  async function scrapeMetadata(page, url) {
    // ... (与 v18 相同)
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
    // 【v19 修改】 使用 downloadAndSaveResource
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
      // 确保 thumbnail 文件名也经过安全处理 (虽然通常是安全的)
      const relativePath = `thumbnail${extension || ".jpg"}`; // 如果没有扩展名，默认为 .jpg
      await downloadAndSaveResource(
        page,
        imageUrl,
        relativePath,
        localGameDir,
        "图片"
      );
    } catch (e) {
      /* downloadAndSaveResource 内部会处理错误日志 */
    }
  }

  async function saveMetadata(localGameDir, metadata) {
    // ... (与 v18 相同)
    if (!metadata.gameName && !metadata.description) {
      console.log(
        `${logPrefix} [信息] 未抓取到元数据，跳过保存 game_info.txt。`
      );
      return;
    }
    const content = `### 游戏名称 (Game Title) ###\n${
      metadata.gameName || "N/A"
    }(${ORIGINAL_GAME_SLUG_NAME})\n### 发行商 (Published by) ###\n${
      metadata.publishedBy || "N/A"
    }\n### 游戏ID (Game ID) ###\n${
      GAME_INSTANCE_ID || "N/A"
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
    const localGameDir = path.join(DOWNLOAD_BASE_DIR, DOWNLOAD_FOLDER_NAME);
    console.log(`${logPrefix} 资源将保存到: ${localGameDir}`);

    // --- 阶段 0: 抓取元数据和图片 ---
    console.log(`\n${logPrefix} --- 阶段 0: 抓取元数据 (Metadata) ---`);
    const metadataPage = await browser.newPage();
    const LANDING_PAGE_URL = `https://gamedistribution.com/games/${ORIGINAL_GAME_SLUG_NAME}`;
    const metadata = await scrapeMetadata(metadataPage, LANDING_PAGE_URL);
    await saveMetadata(localGameDir, metadata);
    await scrapeImage(metadataPage, metadata.imageUrl, localGameDir); // 使用新的 scrapeImage
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
    await scrapeByPatternGuessing(
      gamePage,
      gameRootPathname,
      localGameDir,
      processedUrls
    );
  } catch (e) {
    console.error(`${logPrefix} 发生致命错误: ${e.message}`);
  } finally {
    // 【v19 新增】 保存跳过的文件日志
    if (skippedFilesLog.length > 0) {
      const logPath = path.join(
        DOWNLOAD_BASE_DIR,
        GAME_INSTANCE_ID,
        "skipped_files.txt"
      );
      try {
        await fs.mkdir(path.dirname(logPath), { recursive: true });
        // 对 URL 进行排序和去重
        const uniqueSkippedUrls = [...new Set(skippedFilesLog)].sort();
        await fs.writeFile(logPath, uniqueSkippedUrls.join("\n"));
        console.log(
          `${logPrefix} [信息] ${uniqueSkippedUrls.length} 个跳过的文件 URL 已记录到 ${logPath}`
        );
      } catch (logError) {
        console.error(
          `${logPrefix} [失败] 无法写入 skipped_files.txt: ${logError.message}`
        );
      }
    }

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
  // 【v18 升级】检查并提示安装 sanitize-filename
  try {
    require.resolve("sanitize-filename");
  } catch (e) {
    console.error(
      "\n错误: 缺少 'sanitize-filename' 模块。\n请在项目文件夹中运行 'npm install sanitize-filename' 进行安装。\n"
    );
    process.exit(1); // 退出脚本
  }

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
