/**
 * v21 合并版（Auto + Cleaner）
 *
 * 关键能力：
 * - 全自动阶段化抓取（0~5），保持你原有结构与日志
 * - 跨域/CDN 资源：后缀白名单 + 内容类型判断，外域落地到 _ext/<host>/...
 * - 206/Content-Range 分块：自动二次拉完整体，避免“半个文件”
 * - 自动交互：点击/按键 + 多轮 waitForNetworkIdle 触发运行期加载
 * - 误标 text/html：fetch 侧软失败告警；保存侧仍避免把非 index 的 HTML 当资源
 * - 资源发现扩展：.mjs/.html 也扫，JS/CSS/HTML 正则更广，JSON 深搜字符串，支持 http 绝对路径
 * - Service Worker 缓存抓取（如存在）
 * - 资源判别器：拦广告/埋点/像素/小体积跨域 XHR 等无用资源；可切换策略
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

// 任务队列（示例，可自行扩展）
const GAMES_TO_SCRAPE = [
  {
    slug: "road-digging-puzzle",
    http_root: "be305649d03f439eb03340d2bdf9543a",
  },
  // { slug: "scp-laboratory-idle-secret", http_root: "fa8eb6fd876d4423b1b1ec26f11ee394",folder_name: "scp-laboratory-idle-secret" },
  // {
  //   slug: "anime-dress-up-doll-dress-up",
  //   http_root: "277a4d07d41345448bf22177767fdd32",
  //   folder_name: "anime-dress-up-doll-dress-up",
  // },
];

// 并发 & 稳定性
const CONCURRENCY_LIMIT = 1;
const RETRY_LIMIT = 3;
const STAGGER_DELAY_MS = 20000;
const PHASE1_EXTRA_WAIT_MS = 15000; // load 后额外等待
const NETWORK_IDLE_IDLE_MS = 1500; // 每轮空闲窗口
const NETWORK_IDLE_TIMEOUT_MS = 20000; // 每轮最大等待
const AUTO_INTERACT_ROUNDS = 3; // 自动交互轮数

// 推断策略
const MAX_GUESSED_LEVEL_DEFAULT = 10;

// 保存路径
const DOWNLOAD_BASE_DIR = path.join(__dirname, "downloads");

// ---------- 资源发现/保存白名单 ----------
const MANIFEST_FILE_EXTENSIONS = [
  // 清单/容器：文本扫描
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
const ALLOWED_EXTS = new Set([
  // 静态资源后缀
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

// ===== 过滤相关配置（新增） =====
const FILTER_MODE = "balanced"; // 'off' | 'balanced' | 'paranoid'
const CROSS_ORIGIN_POLICY = "allowlist"; // 'all' | 'allowlist' | 'root-only'
const EXTRA_ALLOWED_HOSTS = []; // 需要放行的第三方静态域
const SKIP_EXTS = new Set([".map", ".md"]); // 典型无用资源，可自行调整
const CORE_ENGINE_EXTS = new Set([".data", ".unityweb", ".wasm", ".bundle"]);
const MIN_PIXEL_IMAGE_BYTES = 256;

// 常见广告/统计/监控域（可按需增删）
const TRACKING_HOST_PATTERNS = [
  /(^|\.)googletagmanager\.com$/i,
  /(^|\.)google-analytics\.com$/i,
  /(^|\.)analytics\.google\.com$/i,
  /(^|\.)doubleclick\.net$/i,
  /(^|\.)googlesyndication\.com$/i,
  /(^|\.)adservice\.google\.com$/i,
  /(^|\.)adnxs\.com$/i,
  /(^|\.)rubiconproject\.com$/i,
  /(^|\.)criteo\.(com|net)$/i,
  /(^|\.)pubmatic\.com$/i,
  /(^|\.)taboola\.com$/i,
  /(^|\.)outbrain\.com$/i,
  /(^|\.)scorecardresearch\.com$/i,
  /(^|\.)demdex\.net$/i,
  /(^|\.)facebook\.com$/i,
  /(^|\.)sentry\.io$/i,
  /(^|\.)datadoghq\.com$/i,
  /(^|\.)bugsnag\.com$/i,
  /(^|\.)nr-data\.net$/i,
  /(^|\.)newrelic\.com$/i,
  /(^|\.)segment\.(io|com)$/i,
  /(^|\.)mixpanel\.com$/i,
  /(^|\.)amplitude\.com$/i,
  /(^|\.)braze\.com$/i,
  /(^|\.)appboy\.com$/i,
  /(^|\.)intercom\.io$/i,
  /(^|\.)onesignal\.com$/i,
  /(^|\.)branch\.io$/i,
  /(^|\.)appsflyer\.com$/i,
  /(^|\.)adjust\.com$/i,
];
const PATH_KEYWORDS_BLOCK = [
  "/ads/",
  "/adservice",
  "/prebid",
  "/gpt",
  "/impression",
  "/pixel",
  "/analytics",
  "/collect",
  "/beacon",
  "/metrics",
  "/stats",
  "/sentry",
  "/bugsnag",
  "/datadog",
  "/hotjar",
  "/rollbar",
  "/newrelic",
  "/segment",
  "/mixpanel",
  "/amplitude",
  "/onesignal",
  "/intercom",
  "/braze",
  "/branch",
];

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
    folder_name: INPUT_FOLDER_NAME, // 不直接当目录名，用于后续判断
  } = game;

  // 用 slug 生成一个“安全的”备用目录名（与原逻辑一致：只保留字母数字和连字符）
  const SANITIZED_GAME_SLUG_NAME = ORIGINAL_GAME_SLUG_NAME.replace(
    /[^a-zA-Z0-9\-]/g,
    ""
  );

  // 决定最终目录名：优先用非空的 folder_name，否则回退到 slug；再用 sanitize 做一次跨平台安全清洗
  const DOWNLOAD_FOLDER_NAME = sanitize(
    typeof INPUT_FOLDER_NAME === "string" && INPUT_FOLDER_NAME.trim().length > 0
      ? INPUT_FOLDER_NAME.trim()
      : SANITIZED_GAME_SLUG_NAME,
    { replacement: "_" }
  );
  const GAME_ROOT_URL = `https://html5.gamedistribution.com/rvvASMiM/${GAME_INSTANCE_ID}/`;
  const LANDING_PAGE_URL = `https://gamedistribution.com/games/${ORIGINAL_GAME_SLUG_NAME}`;
  const logPrefix = `[Worker ${workerId} | ${ORIGINAL_GAME_SLUG_NAME}]`;
  const initialLevelPaths = new Set();
  const skippedFilesLog = [];

  // 过滤统计
  const allowedHosts = new Set([
    new URL(GAME_ROOT_URL).host,
    ...EXTRA_ALLOWED_HOSTS,
  ]);
  const assetReport = {
    kept: 0,
    skipped: 0,
    reasons: {},
    byHost: {},
    byExt: {},
  };
  function _bump(obj, key) {
    obj[key] = (obj[key] || 0) + 1;
  }
  function noteReport(keepOrSkip, url, reason, phaseName) {
    const u = new URL(url);
    const ext = (path.posix.extname(u.pathname) || "").toLowerCase();
    if (keepOrSkip === "keep") {
      assetReport.kept++;
      _bump(assetReport.byHost, u.host);
      _bump(assetReport.byExt, ext || "(none)");
    } else {
      assetReport.skipped++;
      _bump(assetReport.reasons, `${reason}@${phaseName || "-"}`);
    }
  }

  console.log(`${logPrefix} 任务启动... 目标: ${GAME_ROOT_URL}`);
  console.log(
    `${logPrefix} 清理后 Slug: ${SANITIZED_GAME_SLUG_NAME}, 元数据 URL: ${LANDING_PAGE_URL}`
  );

  // --- 2) 内部工具（隔离） ---

  // 查询串哈希 → 避免同路径不同版本覆盖
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

  // 为任意 URL 生成保存相对路径（含跨域规则）
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

  // 内容是否“像资产”
  function isLikelyAsset(urlObj, headers) {
    const ext = (path.posix.extname(urlObj.pathname) || "").toLowerCase();
    if (ext && ALLOWED_EXTS.has(ext)) return true;
    const ct = (
      headers["content-type"] ||
      headers["Content-Type"] ||
      ""
    ).toLowerCase();
    if (!ct) return false;
    if (ct.includes("text/html")) return false;
    return (
      /^(image|audio|video|font)\//.test(ct) ||
      /application\/(octet-stream|wasm|json|x-font|vnd)/.test(ct)
    );
  }

  // 资源判别器：在保存前统一判定是否跳过
  function shouldSkipAsset(url, ctx = {}) {
    if (FILTER_MODE === "off") return { skip: false };

    const u = new URL(url);
    const host = u.host;
    const ext = (path.posix.extname(u.pathname) || "").toLowerCase();
    const ct = (
      ctx.headers?.["content-type"] ||
      ctx.headers?.["Content-Type"] ||
      ""
    ).toLowerCase();
    const len = parseInt(ctx.headers?.["content-length"] || "0", 10) || 0;
    const rt = ctx.resourceType || "other";
    const status = ctx.status || 0;
    const inRoot = !!ctx.inGameRoot;

    // 1) 永远保留：引擎关键件 & 根域静态资源
    if (CORE_ENGINE_EXTS.has(ext)) return { skip: false };
    if (inRoot && (ext || ct)) {
      if (
        ct.includes("text/html") &&
        !u.pathname.endsWith("/") &&
        !u.pathname.endsWith(".html")
      ) {
        return { skip: true, reason: "root-html-nonindex" };
      }
      return { skip: false };
    }

    // 2) 扩展名类“明显无关”
    if (SKIP_EXTS.has(ext)) return { skip: true, reason: `skip-ext:${ext}` };

    // 3) 域名黑名单（广告/统计/监控）
    for (const p of TRACKING_HOST_PATTERNS) {
      if (p.test(host)) return { skip: true, reason: "tracking-host" };
    }

    // 4) 路径关键词（埋点/广告）
    const lowPath = (u.pathname + u.search).toLowerCase();
    if (PATH_KEYWORDS_BLOCK.some((k) => lowPath.includes(k))) {
      return { skip: true, reason: "tracking-path" };
    }

    // 5) 跨域策略
    if (!inRoot) {
      if (CROSS_ORIGIN_POLICY === "root-only")
        return { skip: true, reason: "x-origin-block" };
      if (CROSS_ORIGIN_POLICY === "allowlist" && !allowedHosts.has(host)) {
        const looksBinary =
          CORE_ENGINE_EXTS.has(ext) ||
          (ext &&
            ALLOWED_EXTS.has(ext) &&
            !/\.js|\.mjs|\.json|\.html?$/.test(ext)) ||
          /^(image|audio|video|font)\//.test(ct) ||
          /application\/(octet-stream|wasm)/.test(ct);
        if (looksBinary && (len >= 512 || ctx.preflight)) {
          allowedHosts.add(host); // 自学习：放行一次后加入白名单
        } else {
          return { skip: true, reason: "x-origin-not-asset" };
        }
      }
    }

    // 6) 小像素图/无内容埋点
    if (/^image\//.test(ct) && len > 0 && len < MIN_PIXEL_IMAGE_BYTES) {
      if (/pixel|impression|track/.test(lowPath))
        return { skip: true, reason: "tiny-pixel" };
    }
    if ((rt === "xhr" || rt === "fetch") && !inRoot) {
      if (
        status === 204 ||
        (len > 0 && len < 512 && /json|plain|text/.test(ct))
      ) {
        return { skip: true, reason: "tiny-xhr-telemetry" };
      }
    }

    return { skip: false };
  }

  // 路径解码与验证（保留）
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
        // allow
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

  // fetchFromBrowser：HTML 软失败 + 告警
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
          // 软失败：即便 text/html 也返回字节，由调用方决定是否保存
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

  // 统一下载错误处理（保留）
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
    } catch {}

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

  // 主动下载（带预判过滤）
  async function downloadAndSaveResource(
    page,
    fileFullUrl,
    originalFileRelPath,
    localGameDir,
    phaseName
  ) {
    const pre = shouldSkipAsset(fileFullUrl, {
      preflight: true,
      inGameRoot: fileFullUrl.startsWith(GAME_ROOT_URL),
      phaseName,
    });
    if (pre.skip) {
      noteReport("skip", fileFullUrl, pre.reason, phaseName);
      return;
    }

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
        noteReport("keep", fileFullUrl, null, phaseName);
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

  // 被动响应处理（跨域 + 206 + HTML 软失败 + 过滤）
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
    if (!isRootHtmlCandidate && !allowedByType) return;

    // 记录初始路径（供模式推断）
    if (recordPaths && inGameRoot) {
      const relForRecord =
        urlObj.pathname.substring(gameRootPathname.length) || "index.html";
      if (relForRecord !== "index.html") initialLevelPaths.add(relForRecord);
    }

    // 过滤判定（保存前）
    const decision = shouldSkipAsset(requestUrl, {
      headers,
      status,
      resourceType: response.request().resourceType?.(),
      inGameRoot,
      phaseName: "被动",
    });
    if (decision.skip) {
      noteReport("skip", requestUrl, decision.reason, "被动");
      return;
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
        noteReport("keep", requestUrl, null, "被动");
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

  // 阶段 2：Unity JSON 关键件补齐（保留）
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

  // 阶段 3：递归清单（.js/.mjs/.html/.json/.css 等）
  async function scrapeFromManifestsRecursive(
    page,
    gameRootPathname,
    localGameDir,
    processedUrls
  ) {
    console.log(
      `\n${logPrefix} --- 阶段 3: 主动抓取(递归) 清单中的引用资源 ---`
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

        // 1) 正则提取（JS/CSS/HTML 文本）
        let regex = isCss ? CSS_RESOURCE_REGEX : RESOURCE_REGEX;
        regex.lastIndex = 0;
        let match;
        while ((match = regex.exec(content)) !== null) {
          let foundPath = isCss ? match[2] : match[2];
          if (!foundPath) continue;
          foundPath = foundPath
            .trim()
            .replace(/^["']|["']$/g, "")
            .split("#")[0]; // 清理

          if (/^(data:|blob:|about:)/i.test(foundPath)) continue;

          let resolvedUrl;
          try {
            resolvedUrl = foundPath.startsWith("http")
              ? foundPath
              : new URL(foundPath, manifestUrl).href;
          } catch {
            continue;
          }

          const ext2 = (
            path.posix.extname(new URL(resolvedUrl).pathname) || ""
          ).toLowerCase();
          if (!ext2 || !ALLOWED_EXTS.has(ext2)) {
            // 为防把 HTML 或接口当资源，只有明确后缀才加入
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

        // 2) JSON 深搜：字符串值里可能藏着路径/接口
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

  // 阶段 4：模式推断（放宽：任意数字起点；上限=已见最大值+5 或默认）
  async function scrapeByPatternGuessing(
    page,
    gameRootPathname,
    localGameDir,
    processedUrls
  ) {
    console.log(`\n${logPrefix} --- 阶段 4: 基于模式推断抓取资源 ---`);
    const guessedResourcesToDownload = new Map();

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

  // 阶段 5：抓取 SW 缓存（如存在）
  async function scrapeFromSWCaches(page, localGameDir, processedUrls) {
    console.log(`\n${logPrefix} --- 阶段 5: 抓取 Service Worker 缓存 ---`);
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
        const ext = (path.posix.extname(urlObj.pathname) || "").toLowerCase();
        if (!ext || (!ALLOWED_EXTS.has(ext) && !u.endsWith("/"))) continue;
        const pre = shouldSkipAsset(u, {
          preflight: true,
          inGameRoot: u.startsWith(GAME_ROOT_URL),
          phaseName: "SW缓存",
        });
        if (pre.skip) {
          noteReport("skip", u, pre.reason, "SW缓存");
          continue;
        }
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
        timeout: 200000,
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

    // 自动交互 + 多轮网络空闲
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
    // 过滤报告
    try {
      const repPath = path.join(
        DOWNLOAD_BASE_DIR,
        DOWNLOAD_FOLDER_NAME,
        "asset_report.json"
      );
      await fs.mkdir(path.dirname(repPath), { recursive: true });
      await fs.writeFile(repPath, JSON.stringify(assetReport, null, 2));
      console.log(
        `${logPrefix} [信息] 过滤报告已写入 ${repPath}（保留:${assetReport.kept} 跳过:${assetReport.skipped}）`
      );
    } catch (e) {
      console.warn(
        `${logPrefix} [警告] 写入 asset_report.json 失败: ${e.message}`
      );
    }

    // 保留你原来的 skipped_files.txt 位置与逻辑
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
  // 依赖检查（与原脚本一致）
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
