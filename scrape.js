/**
 * v20 合并版（全面自动抓取）
 * 关键增强：
 * - 跨域/CDN 资源：按后缀白名单 + 内容类型判断，落地到 _ext/<host>/...
 * - 206/Content-Range：识别分块响应，自动二次拉取完整体
 * - 自动交互：点击/按键 + 多轮 waitForNetworkIdle 触发延迟加载
 * - 误标 text/html：从“硬拦截”改为“软失败 + 告警”
 * - 资源发现扩展：新增 .mjs/.html 作为清单；正则覆盖 gif/webp/avif/otf/glb/gltf/ktx2/drc 等
 * - （可选）抓取 Service Worker 缓存中的资源
 *
 * 保持：阶段化结构（0 元数据 / 1 被动监听 / 2 Unity JSON / 3 递归清单 / 4 模式推断）、日志、写盘策略。
 */

"use strict";

// ---- 依赖 ----
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin()); // 隐身
const fs = require("fs").promises;
const path = require("path");
const { URL } = require("url");
const sanitize = require("sanitize-filename");
const crypto = require("crypto");

// -------------------------------------------------
// ----------------- 全局配置区域 ------------------
// -------------------------------------------------

// 任务队列（示例保持不变，可自行扩展）
const GAMES_TO_SCRAPE = [
  {
    slug: "brainrot-mega-parkour",
    http_root: "52c85b3037d84d5f9fbd7108bc832ccc",
    folder_name: "brainrot-mega-parkour",
  },
  // { slug: "mega-lamba-ramp", http_root: "08f7196aa8c241dc81f27f118fa1f61e", folder_name: "mega-lamba-ramp" }, // 存在问题
];

// 并发 & 稳定性
const CONCURRENCY_LIMIT = 1;
const RETRY_LIMIT = 3;
const STAGGER_DELAY_MS = 10000;
const PHASE1_EXTRA_WAIT_MS = 15000; // load 后额外等待
const NETWORK_IDLE_IDLE_MS = 1500; // 每轮空闲窗口
const NETWORK_IDLE_TIMEOUT_MS = 20000; // 每轮最大等待
const AUTO_INTERACT_ROUNDS = 3; // 自动交互轮数

// 推断策略
const MAX_GUESSED_LEVEL_DEFAULT = 10; // 若没探测到关卡数字，默认最多猜 10

// 保存路径
const DOWNLOAD_BASE_DIR = path.join(__dirname, "downloads");

// ---------- v20：扩展扫描与后缀白名单 ----------
const MANIFEST_FILE_EXTENSIONS = [
  // 作为“清单/容器”扫描的文本类型
  ".js",
  ".mjs",
  ".html",
  ".json",
  ".txt",
  ".xml",
  ".atlas",
  ".css",
  ".plist",
  ".fnt",
];

// 覆盖更全面的静态资源后缀
const ALLOWED_EXTS = new Set([
  ".js",
  ".mjs",
  ".json",
  ".txt",
  ".xml",
  ".atlas",
  ".css",
  ".plist",
  ".fnt",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".mp3",
  ".ogg",
  ".wav",
  ".m4a",
  ".bin",
  ".data",
  ".bundle",
  ".unityweb",
  ".wasm",
  ".svg",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".mp4",
  ".webm",
  ".glb",
  ".gltf",
  ".ktx2",
  ".drc",
]);

// 文本中的路径匹配（更广）
const RESOURCE_REGEX =
  /(["'])([\w\-\/\.]+\.(json|png|jpg|jpeg|gif|webp|avif|mp3|ogg|wav|m4a|bin|data|bundle|txt|xml|atlas|unityweb|wasm|css|plist|fnt|svg|woff|woff2|ttf|otf|eot|mp4|webm|glb|gltf|ktx2|drc))\1/gi;
const CSS_RESOURCE_REGEX = /url\((["']?)([^)]+?)\1\)/gi;

// v19 既有校验（保留）
const INVALID_PATH_CHARS_REGEX = /[<>:"\/\\|?*]/;
const ONLY_EXTENSION_REGEX = /^\.[a-zA-Z0-9]+$/;
const REMAINING_ENCODING_REGEX = /%[0-9A-Fa-f]{2}/;
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
        `${logPrefix} [失败] 导航到 ${url} 失败 (第 ${i} 次): ${e.message}`
      );
      if (i < RETRY_LIMIT) {
        const waitTime = i * 2000;
        console.log(`${logPrefix} [信息] ${waitTime / 1000}s 后重试...`);
        await delay(waitTime);
      }
    }
  }
  throw new Error(`导航到 ${url} 失败 ${RETRY_LIMIT} 次。`);
}

// -------------------------------------------------
// ------------- 单个游戏的工作函数 ----------------
// -------------------------------------------------

async function scrapeGame(game, workerId) {
  // --- 1) 任务常量 ---
  const {
    slug: ORIGINAL_GAME_SLUG_NAME,
    http_root: GAME_INSTANCE_ID,
    folder_name: DOWNLOAD_FOLDER_NAME,
  } = game;
  const SANITIZED_GAME_SLUG_NAME = ORIGINAL_GAME_SLUG_NAME.replace(
    /[^a-zA-Z0-9\-]/g,
    ""
  );
  const GAME_ROOT_URL = `https://html5.gamedistribution.com/rvvASMiM/${GAME_INSTANCE_ID}/`;
  const LANDING_PAGE_URL = `https://gamedistribution.com/games/${ORIGINAL_GAME_SLUG_NAME}`;
  const logPrefix = `[Worker ${workerId} | ${ORIGINAL_GAME_SLUG_NAME}]`;
  const initialLevelPaths = new Set();
  const skippedFilesLog = [];

  console.log(`${logPrefix} 任务启动... 目标: ${GAME_ROOT_URL}`);
  console.log(
    `${logPrefix} 清理后 Slug: ${SANITIZED_GAME_SLUG_NAME}, 元数据 URL: ${LANDING_PAGE_URL}`
  );

  // --- 2) 内部工具（隔离） ---

  // v20：把查询串哈希进文件名，避免覆盖
  function appendQueryHash(relPath, urlObj) {
    if (!urlObj.search) return relPath;
    const qh = crypto
      .createHash("md5")
      .update(urlObj.search)
      .digest("hex")
      .slice(0, 8);
    const parsed = path.posix.parse(relPath); // { dir, base, name, ext }
    const baseWithHash = `${parsed.name}__q_${qh}${parsed.ext || ""}`;
    return path.posix.join(parsed.dir || "", baseWithHash);
  }

  // v20：为任意 URL 生成“保存用相对路径”（含跨域与 index.html 逻辑）
  function proposeRelativePathForUrl(url) {
    const u = new URL(url);
    const inGameRoot = url.startsWith(GAME_ROOT_URL);
    let rel = inGameRoot
      ? u.pathname.substring(new URL(GAME_ROOT_URL).pathname.length)
      : path.posix.join("_ext", u.host, u.pathname);
    if (!rel || rel.endsWith("/"))
      rel = path.posix.join(rel || "", "index.html");
    rel = appendQueryHash(rel, u);
    return rel;
  }

  // v19：路径解码 + 校验（保留）
  function getSafeRelativePath(
    originalRelativePath,
    originalUrl,
    phaseName,
    logPrefix
  ) {
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(originalRelativePath);
    } catch (e) {
      downloadResourceErrorHandler(e, originalUrl, phaseName, "路径解码失败");
      return null;
    }
    const basename = path.posix.basename(decodedPath);
    if (
      decodedPath.length === 0 ||
      decodedPath.length > MAX_FILENAME_LENGTH ||
      INVALID_PATH_CHARS_REGEX.test(decodedPath.replace(/\//g, "")) ||
      REMAINING_ENCODING_REGEX.test(decodedPath) ||
      (ONLY_EXTENSION_REGEX.test(basename) && basename.length > 1)
    ) {
      if (
        originalRelativePath === "index.html" &&
        decodedPath === "index.html"
      ) {
        // 允许 index.html
      } else {
        downloadResourceErrorHandler(
          null,
          originalUrl,
          phaseName,
          "无效文件名/路径"
        );
        return null;
      }
    }
    const sanitized = decodedPath
      .split("/")
      .map((seg) => sanitize(seg, { replacement: "_" }))
      .join("/");
    if (decodedPath !== sanitized) {
      console.warn(
        `${logPrefix} [警告] (阶段: ${phaseName}) 清理路径: "${decodedPath}" -> "${sanitized}"`
      );
    }
    return sanitized;
  }

  // v20：判断响应是否为“可抓资源”（后缀或内容类型）
  function isLikelyAsset(urlObj, headers) {
    const ext = (path.posix.extname(urlObj.pathname) || "").toLowerCase();
    if (ext && ALLOWED_EXTS.has(ext)) return true;
    const ct = (
      headers["content-type"] ||
      headers["Content-Type"] ||
      ""
    ).toLowerCase();
    if (!ct) return false;
    if (ct.includes("text/html")) return false; // HTML 另行处理（仅保存 index.html）
    return (
      /^(image|audio|video|font)\//.test(ct) ||
      /application\/(octet-stream|wasm|json|x-font|vnd)/.test(ct)
    );
  }

  // v19：fetchFromBrowser（改为 text/html 软失败 + 告警）
  async function fetchFromBrowser(page, url) {
    try {
      if (page.isClosed()) throw new Error("Page was closed");
      const encodedUrl = encodeURI(url);
      const result = await page.evaluate(async (url) => {
        try {
          const response = await fetch(url, { cache: "default" });
          const contentType = response.headers.get("content-type") || "";
          if (!response.ok) {
            return {
              error: `Fetch failed with status ${response.status} for ${url}`,
              contentType,
            };
          }
          // v20：不再硬拒 HTML（部分 CDN 误标），改为软告警
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

  // v19：统一下载错误处理（保留）
  function downloadResourceErrorHandler(
    error,
    originalUrlOrPath,
    phaseName,
    skipReason = null
  ) {
    let displayPath = originalUrlOrPath;
    try {
      if (originalUrlOrPath.startsWith("http")) {
        const urlObj = new URL(originalUrlOrPath);
        displayPath = decodeURIComponent(urlObj.pathname);
      } else {
        displayPath = decodeURIComponent(originalUrlOrPath);
      }
    } catch (e) {}

    const gameRootPathname = new URL(GAME_ROOT_URL).pathname;
    if (displayPath.startsWith(gameRootPathname)) {
      displayPath = displayPath.substring(gameRootPathname.length);
    }

    if (error?.message?.includes("Fetch failed with status 404")) {
      console.log(
        `${logPrefix} [跳过-404] ${displayPath} (阶段: ${phaseName})`
      );
    } else if (skipReason) {
      console.warn(
        `${logPrefix} [跳过-${skipReason}] ${displayPath} (阶段: ${phaseName})`
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

  // v19：统一主动下载（改：允许跨域路径规则）
  async function downloadAndSaveResource(
    page,
    fileFullUrl,
    originalFileRelPath,
    localGameDir,
    phaseName
  ) {
    const safeRelativePath = getSafeRelativePath(
      originalFileRelPath,
      fileFullUrl,
      phaseName,
      logPrefix
    );
    if (!safeRelativePath) return;

    try {
      const buffer = await fetchFromBrowser(page, fileFullUrl);
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
      downloadResourceErrorHandler(fetchError, fileFullUrl, phaseName);
    }
  }

  // v20：被动响应处理（跨域 + 206 + HTML 软失败）
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
    const headers = response.headers();
    const urlObj = new URL(requestUrl);

    if (status >= 400 || processedUrls.has(requestUrl)) return;

    const inGameRoot = requestUrl.startsWith(GAME_ROOT_URL);
    const ext = (path.posix.extname(urlObj.pathname) || "").toLowerCase();
    const ct = (headers["content-type"] || "").toLowerCase();

    const isRootHtmlCandidate =
      inGameRoot &&
      (urlObj.pathname === gameRootPathname || urlObj.pathname.endsWith("/"));
    const allowedByType =
      isLikelyAsset(urlObj, headers) || (inGameRoot && ext === ".html");

    if (!isRootHtmlCandidate && !allowedByType) {
      // 非资源，跳过（减少无谓保存）
      return;
    }

    // 记录“初始关卡路径”仅限根路径下（供模式推断）
    if (recordPaths && inGameRoot) {
      const relForRecord =
        urlObj.pathname.substring(gameRootPathname.length) || "index.html";
      if (relForRecord !== "index.html") initialLevelPaths.add(relForRecord);
    }

    processedUrls.add(requestUrl);

    const proposedRel = proposeRelativePathForUrl(requestUrl);
    const safeRelativePath = getSafeRelativePath(
      proposedRel,
      requestUrl,
      "被动",
      logPrefix
    );
    if (!safeRelativePath) return;

    const localSavePath = path.join(localGameDir, safeRelativePath);

    try {
      let buffer = null;

      if (status === 304) {
        console.log(
          `${logPrefix} [缓存 304] ${safeRelativePath}, 使用 fetch...`
        );
        buffer = await fetchFromBrowser(page, requestUrl);
      } else if (status >= 200 && status < 300) {
        const isPartial = status === 206 || !!headers["content-range"];
        const isHtml = ct.includes("text/html");

        if (isHtml && safeRelativePath !== "index.html") {
          downloadResourceErrorHandler(null, requestUrl, "被动", "HTML内容");
          return;
        }
        if (!isPartial) {
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
          console.warn(
            `${logPrefix} [警告] ${safeRelativePath} 为 206/分块，尝试 fetch 全量...`
          );
          buffer = await fetchFromBrowser(page, requestUrl);
        }
      }
      if (!buffer) return;

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
    } catch (fetchError) {
      downloadResourceErrorHandler(fetchError, requestUrl, "被动");
    }
  }

  // v19：阶段 2（Unity JSON）保持
  async function scrapeFromUnityJson(
    page,
    gameRootPathname,
    localGameDir,
    processedUrls
  ) {
    console.log(`\n${logPrefix} --- 阶段 2: 主动检查 Unity JSON ---`);
    const jsonUrl = Array.from(processedUrls).find(
      (url) => url.startsWith(GAME_ROOT_URL) && url.endsWith(".json")
    );
    if (!jsonUrl) {
      console.log(`${logPrefix} [信息] 未找到 Unity .json 配置，跳过阶段 2。`);
      console.log(`${logPrefix} --- 阶段 2 完成 ---`);
      return;
    }
    const parsedJsonUrl = new URL(jsonUrl);
    const relJsonSaved = proposeRelativePathForUrl(jsonUrl);
    const safeRelJson = getSafeRelativePath(
      relJsonSaved,
      jsonUrl,
      "主动-JSON",
      logPrefix
    );
    const localJsonPath = path.join(localGameDir, safeRelJson);

    let config;
    try {
      config = JSON.parse(await fs.readFile(localJsonPath, "utf-8"));
    } catch (e) {
      console.error(
        `${logPrefix} [失败] 无法读取本地 JSON ${localJsonPath}: ${e.message}`
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
    const buildDir = path.posix.dirname(relJsonSaved);
    const manualPromises = [];

    for (const key of urlKeys) {
      const filename = config[key];
      if (!filename || typeof filename !== "string") continue;
      const fileRelPath = path.posix
        .join(buildDir, filename)
        .replace(/\\/g, "/");
      const fileFullUrl = new URL(fileRelPath, GAME_ROOT_URL).href;
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

  // v20：阶段 3 扩展（跨域 + .mjs/.html + 更广后缀；允许 http 绝对路径）
  async function scrapeFromManifestsRecursive(
    page,
    gameRootPathname,
    localGameDir,
    processedUrls
  ) {
    console.log(
      `\n${logPrefix} --- 阶段 3: 主动抓取(递归) JS/JSON/CSS/HTML 中的引用资源 ---`
    );
    const scannedManifests = new Set();
    let loopCount = 0;

    function findStringValues(obj, foundStrings) {
      for (const key in obj) {
        if (typeof obj[key] === "string") foundStrings.add(obj[key]);
        else if (typeof obj[key] === "object" && obj[key] !== null)
          findStringValues(obj[key], foundStrings);
      }
    }

    while (loopCount < 10) {
      loopCount++;
      const manifestsToScan = Array.from(processedUrls).filter((url) => {
        try {
          const ext = path.posix.extname(new URL(url).pathname).toLowerCase();
          return (
            MANIFEST_FILE_EXTENSIONS.includes(ext) && !scannedManifests.has(url)
          );
        } catch {
          return false;
        }
      });

      if (manifestsToScan.length === 0) {
        console.log(
          `${logPrefix} [信息] (循环 ${
            loopCount - 1
          }) 未发现新的清单，递归完成。`
        );
        break;
      }

      console.log(
        `${logPrefix} [信息] (循环 ${loopCount}) 扫描 ${manifestsToScan.length} 个清单...`
      );
      const newResourcesToDownload = new Map();

      for (const manifestUrl of manifestsToScan) {
        scannedManifests.add(manifestUrl);

        // 定位本地已保存的清单文件（与被动阶段一致的命名）
        const relSaved = proposeRelativePathForUrl(manifestUrl);
        const safeRel = getSafeRelativePath(
          relSaved,
          manifestUrl,
          "清单-读取",
          logPrefix
        );
        if (!safeRel) continue;

        const localPath = path.join(localGameDir, safeRel);
        const ext = path.posix
          .extname(new URL(manifestUrl).pathname)
          .toLowerCase();
        const isCss = ext === ".css";
        const isJson = ext === ".json";

        let content;
        try {
          content = await fs.readFile(localPath, "utf-8");
        } catch (e) {
          console.warn(
            `${logPrefix} [警告] 无法读取清单 ${localPath}: ${e.message}`
          );
          continue;
        }

        // 1) 基于正则（JS/CSS/HTML 文本）
        let regex = isCss ? CSS_RESOURCE_REGEX : RESOURCE_REGEX;
        regex.lastIndex = 0;
        let match;
        while ((match = regex.exec(content)) !== null) {
          let foundPath = isCss ? match[2] : match[2];
          if (!foundPath) continue;

          // 清理 CSS 中的 url(...) 包裹与片段锚点
          foundPath = foundPath
            .trim()
            .replace(/^["']|["']$/g, "")
            .split("#")[0];

          // 跳过 data/blob
          if (/^(data:|blob:|about:)/i.test(foundPath)) continue;

          // 解析为绝对 URL
          let resolvedUrl;
          try {
            resolvedUrl = foundPath.startsWith("http")
              ? foundPath
              : new URL(foundPath, manifestUrl).href;
          } catch {
            continue;
          }

          // 仅基于后缀粗筛（内容类型在真实请求时再判定）
          const ext2 = (
            path.posix.extname(new URL(resolvedUrl).pathname) || ""
          ).toLowerCase();
          if (!ext2 || !ALLOWED_EXTS.has(ext2)) {
            // 保守起见：无扩展名的先忽略（避免把 HTML 页面当资源）
            continue;
          }

          if (
            !processedUrls.has(resolvedUrl) &&
            !newResourcesToDownload.has(resolvedUrl)
          ) {
            const relForSave = proposeRelativePathForUrl(resolvedUrl);
            newResourcesToDownload.set(resolvedUrl, relForSave);
          }
        }

        // 2) JSON 深度取值（保持原有严谨性，稍微放宽：允许无扩展名 JSON 端点，失败再记录）
        if (isJson) {
          try {
            const jsonObj = JSON.parse(content);
            const potentialPaths = new Set();
            findStringValues(jsonObj, potentialPaths);
            for (const found of potentialPaths) {
              if (
                !found ||
                found.startsWith("data:") ||
                found.startsWith("blob:")
              )
                continue;
              let absUrl;
              try {
                absUrl = found.startsWith("http")
                  ? found
                  : new URL(found, manifestUrl).href;
              } catch {
                continue;
              }

              // 若是站外或无扩展名：也允许尝试（保存时会走内容类型判断 & 路径安全）
              if (
                !processedUrls.has(absUrl) &&
                !newResourcesToDownload.has(absUrl)
              ) {
                const relForSave = proposeRelativePathForUrl(absUrl);
                newResourcesToDownload.set(absUrl, relForSave);
              }
            }
          } catch (e) {
            console.warn(
              `${logPrefix} [警告] JSON 解析失败: ${localPath} - ${e.message}`
            );
          }
        }
      }

      // --- 批量下载 ---
      if (newResourcesToDownload.size > 0) {
        console.log(
          `${logPrefix} [信息] (循环 ${loopCount}) 清单新增 ${newResourcesToDownload.size} 个资源，下载中...`
        );
        const downloadPromises = [];
        for (const [
          fileFullUrl,
          relForSave,
        ] of newResourcesToDownload.entries()) {
          processedUrls.add(fileFullUrl);
          downloadPromises.push(
            downloadAndSaveResource(
              page,
              fileFullUrl,
              relForSave,
              localGameDir,
              "清单"
            )
          );
        }
        await Promise.allSettled(downloadPromises);
      } else {
        console.log(`${logPrefix} [信息] (循环 ${loopCount}) 未发现新资源。`);
      }
    }

    if (loopCount >= 10)
      console.warn(`${logPrefix} [警告] 递归扫描达到 10 次上限。`);
    console.log(`${logPrefix} --- 阶段 3 完成 ---`);
  }

  // v20：阶段 4 模式推断（放宽：任意数字起点；上限=已见最大值+5 或默认）
  async function scrapeByPatternGuessing(
    page,
    gameRootPathname,
    localGameDir,
    processedUrls
  ) {
    console.log(`\n${logPrefix} --- 阶段 4: 基于模式推断抓取资源 ---`);
    const guessedResourcesToDownload = new Map();

    // 探测已见的最大数字
    let maxLevelFound = 0;
    const genericNumDirPattern = /\/(\d+)\//;
    for (const url of processedUrls) {
      try {
        const pathName = new URL(url).pathname;
        const m = pathName.match(genericNumDirPattern);
        if (m && m[1])
          maxLevelFound = Math.max(maxLevelFound, parseInt(m[1], 10));
      } catch {}
    }
    const actualMaxGuess = (maxLevelFound > 0 ? maxLevelFound : 5) + 5;
    console.log(
      `${logPrefix} [信息] 最大数字探测: ${
        maxLevelFound || "未探测到"
      }；猜测上限: ${actualMaxGuess}`
    );

    // 常见模式：levelNN / _NN_ / sceneNN / /NN/
    const levelPatterns = [
      { regex: /(level)(\d+)/i, replaceIndex: 2 },
      { regex: /(scene)(\d+)/i, replaceIndex: 2 },
      { regex: /(_)(\d+)(_|\.)/, replaceIndex: 2 },
      { regex: /(\/)(\d+)(\/)/, replaceIndex: 2 },
    ];

    for (const initialPath of initialLevelPaths) {
      for (const { regex, replaceIndex } of levelPatterns) {
        const m = initialPath.match(regex);
        if (!m || !m[replaceIndex] || isNaN(parseInt(m[replaceIndex], 10)))
          continue;

        const current = parseInt(m[replaceIndex], 10);
        for (let next = current + 1; next <= actualMaxGuess; next++) {
          const guessedPath = initialPath.replace(regex, (full, ...groups) => {
            const target = groups[replaceIndex - 1];
            return full.replace(target, String(next));
          });
          if (guessedPath === initialPath) continue;
          const guessedFullUrl = new URL(guessedPath, GAME_ROOT_URL).href;
          if (
            !processedUrls.has(guessedFullUrl) &&
            !guessedResourcesToDownload.has(guessedFullUrl)
          ) {
            console.log(
              `${logPrefix} [推断] 基于 ${initialPath} -> ${guessedPath}`
            );
            guessedResourcesToDownload.set(guessedFullUrl, guessedPath);
          }
        }
      }
    }

    if (guessedResourcesToDownload.size > 0) {
      console.log(
        `${logPrefix} [信息] 推断出 ${guessedResourcesToDownload.size} 个潜在资源，尝试下载...`
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
      console.log(`${logPrefix} [信息] 未推断出新的模式资源。`);
    }
    console.log(`${logPrefix} --- 阶段 4 完成 ---`);
  }

  // v20：可选阶段 5——抓取 Service Worker 缓存中的请求（如存在）
  async function scrapeFromSWCaches(page, localGameDir, processedUrls) {
    console.log(
      `\n${logPrefix} --- 阶段 5: 抓取 Service Worker 缓存 (可选) ---`
    );
    let cachedUrls = [];
    try {
      cachedUrls = await page.evaluate(async () => {
        if (!("caches" in window)) return [];
        const all = [];
        const keys = await caches.keys();
        for (const k of keys) {
          try {
            const cache = await caches.open(k);
            const reqs = await cache.keys();
            for (const r of reqs) all.push(r.url);
          } catch {}
        }
        return Array.from(new Set(all));
      });
    } catch (e) {
      console.warn(`${logPrefix} [警告] 读取 SW 缓存失败: ${e.message}`);
    }

    if (!cachedUrls || cachedUrls.length === 0) {
      console.log(`${logPrefix} [信息] 未发现 SW 缓存或为空，跳过阶段 5。`);
      return;
    }

    const toDownload = [];
    for (const u of cachedUrls) {
      if (processedUrls.has(u)) continue;
      try {
        const urlObj = new URL(u);
        // 基于后缀做一次粗筛；内容类型在真实下载时再校验
        const ext = (path.posix.extname(urlObj.pathname) || "").toLowerCase();
        if (!ext || (!ALLOWED_EXTS.has(ext) && !u.endsWith("/"))) continue; // 避免把 HTML 页当资源
        processedUrls.add(u);
        const rel = proposeRelativePathForUrl(u);
        toDownload.push(
          downloadAndSaveResource(page, u, rel, localGameDir, "SW缓存")
        );
      } catch {}
    }

    if (toDownload.length > 0) {
      console.log(
        `${logPrefix} [信息] SW 缓存中待抓取: ${toDownload.length} 个`
      );
      await Promise.allSettled(toDownload);
    } else {
      console.log(`${logPrefix} [信息] SW 缓存未发现新增资源。`);
    }
    console.log(`${logPrefix} --- 阶段 5 完成 ---`);
  }

  // 元数据抓取（保留）
  async function scrapeMetadata(page, url) {
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
          } catch {
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
        if (!imageUrl)
          imageUrl =
            document.querySelector(
              'div.games_gameThumnailImage__eM2Tb img[alt*="-512x512"]'
            )?.src || null;
        if (!imageUrl)
          imageUrl =
            document.querySelector("div.games_gameThumnailImage__eM2Tb img")
              ?.src || null;
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
    if (!imageUrl) {
      console.log(
        `${logPrefix} [信息] 未在元数据页面找到 imageUrl，跳过缩略图下载。`
      );
      return;
    }
    console.log(`${logPrefix} [信息] 正在抓取缩略图: ${imageUrl}`);
    try {
      const parsedUrl = new URL(imageUrl);
      const extension = path.posix.extname(parsedUrl.pathname);
      const relativePath = `thumbnail${extension || ".jpg"}`;
      await downloadAndSaveResource(
        page,
        imageUrl,
        relativePath,
        localGameDir,
        "图片"
      );
    } catch {}
  }

  async function saveMetadata(localGameDir, metadata) {
    if (!metadata.gameName && !metadata.description) {
      console.log(
        `${logPrefix} [信息] 未抓取到元数据，跳过保存 game_info.txt。`
      );
      return;
    }
    const content =
      `### 游戏名称 (Game Title) ###\n${
        metadata.gameName || "N/A"
      }(${ORIGINAL_GAME_SLUG_NAME})\n` +
      `### 发行商 (Published by) ###\n${metadata.publishedBy || "N/A"}\n` +
      `### 游戏ID (Game ID) ###\n${GAME_INSTANCE_ID || "N/A"}\n` +
      `### 描述 (DESCRIPTION) ###\n${metadata.description || "N/A"}\n` +
      `### 操作指南 (INSTRUCTIONS) ###\n${metadata.instructions || "N/A"}\n` +
      `### 分类 (Category) ###\n${metadata.category || "N/A"}\n` +
      `### 标签 (Tags) ###\n${metadata.tags?.join(", ") || "N/A"}\n`;
    try {
      const savePath = path.join(localGameDir, "game_info.txt");
      await fs.mkdir(path.dirname(savePath), { recursive: true });
      await fs.writeFile(savePath, content.trim());
      console.log(`${logPrefix} [成功] 元数据已保存到 ${savePath}`);
    } catch (e) {
      console.error(`${logPrefix} [失败] 写入元数据文件失败: ${e.message}`);
    }
  }

  // --- 3) 主执行流程 ---
  const downloadPromises = [];
  const processedUrls = new Set();
  let browser;

  try {
    browser = await puppeteer.launch({
      headless: true,
      protocolTimeout: 180000,
    });

    const gameRootParsed = new URL(GAME_ROOT_URL);
    const gameRootPathname = gameRootParsed.pathname;
    const localGameDir = path.join(DOWNLOAD_BASE_DIR, DOWNLOAD_FOLDER_NAME);
    console.log(`${logPrefix} 资源将保存到: ${localGameDir}`);

    // 阶段 0：元数据 & 缩略图
    console.log(`\n${logPrefix} --- 阶段 0: 抓取元数据 (Metadata) ---`);
    const metadataPage = await browser.newPage();
    const metadata = await scrapeMetadata(metadataPage, LANDING_PAGE_URL);
    await saveMetadata(localGameDir, metadata);
    await scrapeImage(metadataPage, metadata.imageUrl, localGameDir);
    await metadataPage.close();
    console.log(`${logPrefix} --- 阶段 0 完成 ---`);

    // 阶段 1：被动监听
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
        )
      );
    });

    await gotoWithRetries(gamePage, GAME_ROOT_URL, logPrefix, {
      waitUntil: "load",
      timeout: 120000,
    });
    console.log(`${logPrefix} 页面 "load" 已触发。`);

    // v20：自动交互 + 多轮网络空闲（触发运行期加载）
    async function autoInteract(page) {
      try {
        const vp = page.viewport() || { width: 800, height: 600 };
        await page.mouse.click(
          Math.floor(vp.width / 2),
          Math.floor(vp.height / 2),
          { clickCount: 2 }
        );
        for (const key of ["Enter", "Space", "ArrowRight", "ArrowUp"]) {
          await page.keyboard.press(key);
          await page.waitForTimeout(200);
        }
      } catch {}
    }
    for (let i = 0; i < AUTO_INTERACT_ROUNDS; i++) {
      await autoInteract(gamePage);
      try {
        await gamePage.waitForNetworkIdle({
          idleTime: NETWORK_IDLE_IDLE_MS,
          timeout: NETWORK_IDLE_TIMEOUT_MS,
        });
      } catch {}
    }

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

    // 阶段 2：Unity JSON
    await scrapeFromUnityJson(
      gamePage,
      gameRootPathname,
      localGameDir,
      processedUrls
    );

    // 阶段 3：递归清单
    await scrapeFromManifestsRecursive(
      gamePage,
      gameRootPathname,
      localGameDir,
      processedUrls
    );

    // 阶段 4：模式推断
    await scrapeByPatternGuessing(
      gamePage,
      gameRootPathname,
      localGameDir,
      processedUrls
    );

    // 阶段 5：SW 缓存（可选）
    await scrapeFromSWCaches(gamePage, localGameDir, processedUrls);
  } catch (e) {
    console.error(`${logPrefix} 发生致命错误: ${e.message}`);
  } finally {
    // 保留 v19：记录跳过文件（仍按原位置，避免行为突变）
    if (skippedFilesLog.length > 0) {
      const logPath = path.join(
        DOWNLOAD_BASE_DIR,
        DOWNLOAD_FOLDER_NAME,
        "skipped_files.txt"
      );
      try {
        await fs.mkdir(path.dirname(logPath), { recursive: true });
        const unique = [...new Set(skippedFilesLog)].sort();
        await fs.writeFile(logPath, unique.join("\n"));
        console.log(
          `${logPrefix} [信息] ${unique.length} 个跳过的文件 URL 已记录到 ${logPath}`
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

async function runPool() {
  // 依赖检查（保留）
  try {
    require.resolve("sanitize-filename");
  } catch {
    console.error(
      `\n错误: 缺少 'sanitize-filename' 模块。\n请运行 'npm install sanitize-filename'\n`
    );
    process.exit(1);
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
        .catch((err) =>
          console.error(
            `[Manager] Worker ${workerId} (${game.slug}) 致命错误:`,
            err
          )
        )
        .finally(() => {
          const i = runningTasks.indexOf(taskPromise);
          if (i >= 0) runningTasks.splice(i, 1);
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

// 入口
runPool();
