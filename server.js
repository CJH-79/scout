/**
 * Scout - Repo Onboarding Agent
 * 输入一个公开 GitHub 仓库，真实读取代码包与依赖清单，产出接手简报。
 *
 * 数据来源刻意绕开 api.github.com（未认证每小时只有 60 次，部署在云端会被共用出口 IP 打爆）：
 *   - 目录树与文件内容 → codeload.github.com 的 tar.gz 源码包（CDN，不限流）
 *   - 仓库元信息（star / 描述）→ api.github.com，拿不到就降级显示，不影响主流程
 * 零 npm 依赖，只使用 Node 内置模块。
 */

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const CACHE = new Map();
const CACHE_TTL = 10 * 60 * 1000;
const MAX_TARBALL = 24 * 1024 * 1024; // 超过 24MB 的源码包不处理
const MAX_FILE_KEEP = 200 * 1024; // 内存里只保留 200KB 以内的文件内容

/* ------------------------------ 网络工具 ------------------------------ */

function httpGetText(url, accept) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: { 'User-Agent': 'scout-onboarding-demo', Accept: accept || 'application/vnd.github+json' },
        timeout: 15000,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          httpGetText(res.headers.location, accept).then(resolve, reject);
          return;
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          data += c;
        });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

function httpGetBuffer(url, maxBytes) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'scout-onboarding-demo', Accept: 'application/gzip' }, timeout: 25000 },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          httpGetBuffer(res.headers.location, maxBytes).then(resolve, reject);
          return;
        }
        if (res.statusCode === 404) {
          res.resume();
          reject(new Error('NOT_FOUND'));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error('HTTP_' + res.statusCode));
          return;
        }
        const declared = Number(res.headers['content-length'] || 0);
        if (declared && declared > maxBytes) {
          res.destroy();
          reject(new Error('TOO_LARGE'));
          return;
        }
        const chunks = [];
        let total = 0;
        res.on('data', (c) => {
          total += c.length;
          if (total > maxBytes) {
            req.destroy();
            reject(new Error('TOO_LARGE'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }
    );
    req.on('timeout', () => req.destroy(new Error('下载超时')));
    req.on('error', reject);
  });
}

/* ------------------------------ 仓库获取 ------------------------------ */

async function fetchMeta(owner, repo) {
  const key = 'meta:' + owner + '/' + repo;
  const hit = CACHE.get(key);
  if (hit && hit.expire > Date.now()) return hit.value;
  try {
    const res = await httpGetText('https://api.github.com/repos/' + owner + '/' + repo);
    if (res.status === 404) throw new Error('NOT_FOUND');
    if (res.status >= 400) return null; // 限流或其它错误：降级，不阻塞主流程
    const value = JSON.parse(res.body);
    CACHE.set(key, { expire: Date.now() + CACHE_TTL, value });
    return value;
  } catch (e) {
    if (e.message === 'NOT_FOUND') throw e;
    return null;
  }
}

/** 解析 tar.gz，返回 { paths, fileMap } */
function parseTarball(gzBuf) {
  const tar = zlib.gunzipSync(gzBuf);
  const paths = [];
  const fileMap = new Map();
  let off = 0;
  let topDir = null;

  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    let allZero = true;
    for (let i = 0; i < 512; i++) {
      if (header[i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) break;

    let name = header.subarray(0, 100).toString('utf8').replace(/\0[\s\S]*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0[\s\S]*$/, '');
    if (prefix) name = prefix + '/' + name;

    const sizeStr = header.subarray(124, 136).toString('ascii').replace(/\0[\s\S]*$/, '').trim();
    const size = parseInt(sizeStr, 8) || 0;
    const typeflag = String.fromCharCode(header[156]);
    const dataStart = off + 512;

    if (typeflag === '0' || typeflag === '') {
      let rel = name.replace(/^\.\//, '');
      const slash = rel.indexOf('/');
      if (slash > 0) {
        if (!topDir) topDir = rel.slice(0, slash);
        rel = rel.slice(slash + 1);
      }
      if (rel && rel.indexOf('.git/') !== 0) {
        paths.push(rel);
        if (size > 0 && size <= MAX_FILE_KEEP) {
          fileMap.set(rel, tar.subarray(dataStart, dataStart + size).toString('utf8'));
        }
      }
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }

  return { paths, fileMap, topDir };
}

async function downloadRepo(owner, repo) {
  const key = 'tar:' + owner + '/' + repo;
  const hit = CACHE.get(key);
  if (hit && hit.expire > Date.now()) return hit.value;

  const url = 'https://codeload.github.com/' + owner + '/' + repo + '/tar.gz/HEAD';
  let buf;
  try {
    buf = await httpGetBuffer(url, MAX_TARBALL);
  } catch (e) {
    if (e.message === 'TOO_LARGE')
      throw new Error('仓库源码包超过 24MB，当前版本只处理中小型仓库，换个小一点的试试');
    if (e.message === 'NOT_FOUND') throw new Error('仓库不存在，或它是私有仓库（本工具只读公开仓库）');
    throw new Error('拉取源码包失败：' + e.message);
  }

  let parsed;
  try {
    parsed = parseTarball(buf);
  } catch (e) {
    throw new Error('源码包解压失败，可能是超大仓库或非标准包');
  }

  const value = { paths: parsed.paths, fileMap: parsed.fileMap, topDir: parsed.topDir };
  CACHE.set(key, { expire: Date.now() + CACHE_TTL, value });
  return value;
}

/* ------------------------------ 知识表 ------------------------------ */

const MANIFESTS = [
  { file: 'package.json', eco: 'Node.js', kind: 'json' },
  { file: 'pom.xml', eco: 'Java / Maven', kind: 'xml' },
  { file: 'build.gradle', eco: 'Java / Gradle', kind: 'gradle' },
  { file: 'build.gradle.kts', eco: 'Kotlin / Gradle', kind: 'gradle' },
  { file: 'requirements.txt', eco: 'Python / pip', kind: 'pip' },
  { file: 'pyproject.toml', eco: 'Python', kind: 'toml' },
  { file: 'go.mod', eco: 'Go', kind: 'gomod' },
  { file: 'Cargo.toml', eco: 'Rust', kind: 'toml' },
  { file: 'composer.json', eco: 'PHP', kind: 'json' },
  { file: 'Gemfile', eco: 'Ruby', kind: 'gemfile' },
];

const FRAMEWORKS = [
  { re: /"next"\s*:|from\s+['"]next|require\(['"]next/i, name: 'Next.js', role: '全栈框架' },
  { re: /"nuxt"\s*:|from\s+['"]nuxt|require\(['"]nuxt/i, name: 'Nuxt', role: '全栈框架' },
  { re: /"react-dom"\s*:|"react"\s*:|from\s+['"]react['"]|require\(['"]react['"]\)/i, name: 'React', role: '前端框架' },
  { re: /"vue"\s*:|from\s+['"]vue['"]|require\(['"]vue['"]\)|vue-loader|@vue\/cli/i, name: 'Vue', role: '前端框架' },
  { re: /@angular\/core/i, name: 'Angular', role: '前端框架' },
  { re: /svelte/i, name: 'Svelte', role: '前端框架' },
  { re: /spring-boot-starter-web|spring-boot-starter-parent|spring-boot-maven-plugin/i, name: 'Spring Boot', role: '后端框架' },
  { re: /spring-cloud/i, name: 'Spring Cloud', role: '微服务' },
  { re: /mybatis-plus/i, name: 'MyBatis-Plus', role: 'ORM' },
  { re: /mybatis/i, name: 'MyBatis', role: 'ORM' },
  { re: /hibernate|spring-boot-starter-data-jpa/i, name: 'JPA / Hibernate', role: 'ORM' },
  { re: /"express"\s*:|require\(['"]express['"]\)|"name"\s*:\s*"express"/i, name: 'Express', role: '后端框架' },
  { re: /"koa"\s*:/i, name: 'Koa', role: '后端框架' },
  { re: /fastify/i, name: 'Fastify', role: '后端框架' },
  { re: /@nestjs\/core/i, name: 'NestJS', role: '后端框架' },
  { re: /django/i, name: 'Django', role: '后端框架' },
  { re: /\bflask\b/i, name: 'Flask', role: '后端框架' },
  { re: /fastapi/i, name: 'FastAPI', role: '后端框架' },
  { re: /gin-gonic\/gin/i, name: 'Gin', role: '后端框架' },
  { re: /prisma/i, name: 'Prisma', role: 'ORM' },
  { re: /typeorm|sequelize|mongoose/i, name: 'ORM', role: 'ORM' },
  { re: /\bredis\b/i, name: 'Redis', role: '中间件' },
  { re: /mysql/i, name: 'MySQL', role: '数据库' },
  { re: /postgres|\bpg\b/i, name: 'PostgreSQL', role: '数据库' },
  { re: /mongo/i, name: 'MongoDB', role: '数据库' },
  { re: /kafka/i, name: 'Kafka', role: '中间件' },
  { re: /rabbitmq|amqp/i, name: 'RabbitMQ', role: '中间件' },
  { re: /tailwind/i, name: 'Tailwind CSS', role: '样式方案' },
  { re: /element-plus|element-ui/i, name: 'Element Plus', role: 'UI 组件库' },
  { re: /antd|ant-design/i, name: 'Ant Design', role: 'UI 组件库' },
  { re: /jest|vitest|mocha|junit|pytest/i, name: '测试框架', role: '测试' },
  { re: /typescript/i, name: 'TypeScript', role: '语言' },
];

const ENTRY_PATTERNS = [
  /^src\/main\.(js|ts|jsx|tsx|py|go|java|kt)$/i,
  /^src\/index\.(js|ts|jsx|tsx)$/i,
  /^src\/app\.(js|ts|jsx|tsx)$/i,
  /^index\.(js|ts|mjs|cjs|py|go|html)$/i,
  /^app\.(js|ts|py)$/i,
  /^server\.(js|ts)$/i,
  /^main\.(py|go|rs)$/i,
  /^cmd\/[^/]+\/main\.go$/,
  /^manage\.py$/,
  /Application\.(java|kt)$/,
  /^src\/App\.(jsx?|tsx?)$/,
];

const DIR_HINTS = [
  [/^(src|source|app|lib)$/i, '主要业务代码'],
  [/^(api|routes?|router|controllers?|handlers?)$/i, '接口 / 路由层'],
  [/^(services?|usecases?|domain|core)$/i, '业务服务层'],
  [/^(models?|entities?|schema|dao|mapper|repository|repositories)$/i, '数据模型 / 持久层'],
  [/^(components?|views?|pages?|ui|layouts?)$/i, 'UI 组件与页面'],
  [/^(tests?|__tests__|spec|e2e)$/i, '测试'],
  [/^(docs?|documentation)$/i, '文档'],
  [/^(scripts?|tools?|bin)$/i, '脚本与工具'],
  [/^(config|configs?|conf|settings)$/i, '配置'],
  [/^(public|static|assets?|images?|img)$/i, '静态资源'],
  [/^(infra|deploy|docker|k8s|helm|terraform)$/i, '部署与基础设施'],
  [/^(migrations?|sql|db)$/i, '数据库迁移 / SQL'],
];

/* ------------------------------ 分析逻辑 ------------------------------ */

function parseRepoInput(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('请输入 GitHub 仓库地址');
  const cleaned = raw
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
  const parts = cleaned.split('/').filter(Boolean);
  if (parts.length < 2) throw new Error('地址格式不对，应该是 owner/repo 或完整仓库链接');
  return { owner: parts[0], repo: parts[1] };
}

function extOf(p) {
  const m = /\.([a-z0-9]+)$/i.exec(p);
  return m ? m[1].toLowerCase() : '(none)';
}

function detectFrameworks(texts) {
  const all = texts.join('\n');
  const hits = [];
  const seen = new Set();
  for (const f of FRAMEWORKS) {
    if (f.re.test(all) && !seen.has(f.name)) {
      seen.add(f.name);
      hits.push({ name: f.name, role: f.role });
    }
  }
  return hits;
}

function pickReadFirst(blobs, manifestsFound) {
  const picks = [];
  const push = (p, reason) => {
    if (p && !picks.some((x) => x.path === p) && picks.length < 5) picks.push({ path: p, reason });
  };

  const readme = blobs.find((p) => /^readme\.(md|markdown|rst|txt)$/i.test(p));
  if (readme) push(readme, '作者自己写的定位与用法，先看这个最省时间');

  const entry = blobs.find((p) => ENTRY_PATTERNS.some((re) => re.test(p)));
  if (entry) push(entry, '看起来是程序入口，从这里往调用链下游读');

  const manifestFile = manifestsFound[0] && manifestsFound[0].path;
  if (manifestFile) push(manifestFile, '依赖清单，能看出技术栈和项目边界');

  const codeFiles = blobs
    .filter((p) => /\.(java|kt|js|ts|jsx|tsx|py|go|vue|rs|php|rb|cs)$/i.test(p))
    .filter((p) => !/Application\.(java|kt)$/i.test(p))
    .filter((p) => !/^(examples?|samples?|tests?|spec|docs?|benchmark|bench|vendor|third[_-]party|node_modules|dist|build)\//i.test(p))
    .filter((p) => !/(^|\/)(dockerfile|config|settings|conf)(\.|$)/i.test(p));
  const bizRe = /\/(controllers?|services?|routes?|api|domain|models?|entities|components|pages|views|handlers|logic)\//i;
  const biz = codeFiles.filter((p) => bizRe.test(p)).sort((a, b) => a.length - b.length)[0];
  const fallback = codeFiles.slice().sort((a, b) => a.length - b.length)[0];
  if (biz || fallback)
    push(biz || fallback, biz ? '核心业务实现，最能看出代码风格和组织方式' : '主要实现文件，先看它理解代码习惯');

  return picks;
}

function suggestFirstTask(blobs) {
  const hasCI = blobs.some((p) => /^\.github\/workflows\//i.test(p));
  const hasTests = blobs.some(
    (p) => /(^|\/)(tests?|__tests__|spec)(\/|$)/i.test(p) || /\.(test|spec)\.(js|ts|jsx|tsx|py|java)$/i.test(p)
  );
  const hasDocker = blobs.some((p) => /(^|\/)dockerfile$/i.test(p) || /docker-compose/i.test(p));
  const hasEnvSample = blobs.some((p) => /(^|\/)\.env\.(example|sample|template)$/i.test(p));

  if (!hasTests) {
    return {
      title: '给一个核心模块补第一组单元测试',
      why: '仓库里没有找到可识别的测试文件，这是最容易上手、也最容易证明价值的第一步。',
      steps: [
        '选一个纯函数或单一职责的模块（没有外部依赖的那种）',
        '用项目已有的测试框架写 3-5 个用例，覆盖正常输入 + 一个边界',
        '提交 PR 时说明覆盖了什么场景，方便维护者 review',
      ],
    };
  }
  if (!hasCI) {
    return {
      title: '补一条最小 CI 流水线',
      why: '有测试但没有 CI 配置，改动全靠人工验证；加一条自动跑测试的流水线成本低、收益直接。',
      steps: [
        '在 .github/workflows 下加一个跑安装 + 测试的 workflow',
        '先只跑 fast 的那部分，避免流水线太慢没人看',
        '在 README 里加状态徽章，让贡献者一眼看到是否通过',
      ],
    };
  }
  if (!hasEnvSample) {
    return {
      title: '整理一份可复现的本地启动说明',
      why: '项目能跑起来，但缺少环境变量样例，新人上手要反复问人；这一步成本低、对团队直接有用。',
      steps: [
        '把代码里读到的环境变量整理成 .env.example',
        '在 README 补一段 "5 分钟跑起来" 的说明，按顺序列命令',
        '验证一遍：删掉本地配置按文档重跑，看是否还通',
      ],
    };
  }
  if (!hasDocker) {
    return {
      title: '补一份容器化运行方式',
      why: '环境说明有了，但缺少可复现的运行环境描述，换台机器就可能跑不起来。',
      steps: [
        '写最小 Dockerfile（或 docker-compose），只求能跑通主流程',
        '把依赖服务和端口写进 compose',
        '在 README 里补一段容器启动说明',
      ],
    };
  }
  return {
    title: '整理一份新人上手文档并修掉一处文档与代码不一致',
    why: '基础设施齐了，最缺的是"别人怎么快速看懂"，同时顺手能验证你对代码的理解。',
    steps: [
      '按"技术栈 → 目录结构 → 怎么跑 → 怎么测"四段写一份 onboarding 文档',
      '边写边核对代码，把发现的过期描述直接改掉',
      '提交时说明你验证过哪些步骤',
    ],
  };
}

function buildOpenQuestions(blobs, manifestsFound, frameworks) {
  const qs = [];
  if (!blobs.some((p) => /^readme\.(md|markdown|rst|txt)$/i.test(p)))
    qs.push('仓库没有 README，项目定位和运行方式需要找人确认');
  if (!blobs.some((p) => /(^|\/)\.env\.(example|sample|template)$/i.test(p)))
    qs.push('缺少 .env.example，本地要配哪些环境变量需要确认');
  if (!blobs.some((p) => /(^|\/)(tests?|__tests__|spec)(\/|$)/i.test(p) || /\.(test|spec)\./i.test(p)))
    qs.push('没有测试文件：这个项目是靠手工验证，还是测试在别处？');
  if (!manifestsFound.length) qs.push('没找到常见依赖清单，技术栈判断可能不完整');
  if (frameworks.some((f) => f.role === '微服务'))
    qs.push('有微服务相关依赖：本地起服务需要哪些注册中心 / 配置中心？');
  return qs.slice(0, 4);
}

async function analyze(owner, repo, emit) {
  emit({ type: 'step', id: 'files', status: 'running', detail: '正在下载源码包' });

  const meta = await fetchMeta(owner, repo).catch(() => null);
  const { paths, fileMap } = await downloadRepo(owner, repo);
  const blobs = paths;

  emit({
    type: 'step',
    id: 'files',
    status: 'done',
    detail: '读到 ' + blobs.length + ' 个文件',
  });

  emit({ type: 'step', id: 'manifest', status: 'running', detail: '正在识别依赖清单' });

  const found = [];
  for (const m of MANIFESTS) {
    if (found.length >= 3) break;
    const hit = blobs.find((p) => p === m.file || p.endsWith('/' + m.file));
    if (!hit) continue;
    const text = fileMap.get(hit);
    if (text) found.push({ ...m, path: hit, text });
  }

  const frameworks = detectFrameworks(found.map((f) => f.text));
  emit({
    type: 'step',
    id: 'manifest',
    status: 'done',
    detail: found.length
      ? '识别到 ' + found.map((f) => f.path).join('、')
      : '没有常见依赖清单（package.json / pom.xml / requirements.txt 等都没找到）',
  });

  emit({ type: 'step', id: 'deps', status: 'running', detail: '正在统计目录结构与模块分布' });

  const dirCount = new Map();
  for (const p of blobs) {
    const seg = p.split('/');
    const top = seg.length > 1 ? seg[0] : '(根目录)';
    dirCount.set(top, (dirCount.get(top) || 0) + 1);
  }
  const modules = [...dirCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([dir, files]) => {
      const hintEntry = DIR_HINTS.find(([re]) => re.test(dir));
      return { dir, files, hint: hintEntry ? hintEntry[1] : '未归类目录' };
    });

  const extCount = new Map();
  for (const p of blobs) {
    const e = extOf(p);
    extCount.set(e, (extCount.get(e) || 0) + 1);
  }
  const topExts = [...extCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);

  emit({
    type: 'step',
    id: 'deps',
    status: 'done',
    detail: '最大目录 ' + (modules[0] ? modules[0].dir + '（' + modules[0].files + ' 个文件）' : '无'),
  });

  emit({ type: 'step', id: 'brief', status: 'running', detail: '正在生成接手简报' });

  const stack = [];
  for (const m of found) {
    if (!stack.some((s) => s.name === m.eco)) stack.push({ name: m.eco, role: '语言 / 构建', evidence: m.path });
  }
  for (const f of frameworks) {
    if (stack.length >= 8) break;
    if (!stack.some((s) => s.name === f.name)) {
      stack.push({ name: f.name, role: f.role, evidence: found[0] ? found[0].path : '目录结构' });
    }
  }
  if (!stack.length && meta && meta.language) {
    stack.push({ name: meta.language, role: '主要语言（按代码量）', evidence: 'GitHub 语言统计' });
  }
  // 没有依赖清单的小项目：按文件扩展名给一个诚实的判断，避免出现空状态
  if (!stack.length) {
    const langs = topExts
      .filter(([e]) => /^(js|ts|jsx|tsx|py|go|java|kt|rs|php|rb|cs|html|vue)$/i.test(e))
      .slice(0, 3)
      .map(([e]) => e.toUpperCase());
    if (langs.length) {
      stack.push({ name: langs.join(' / '), role: '按文件类型推断', evidence: topExts[0][0] + ' 文件最多' });
    }
  }

  // GitHub 元信息拿不到（云端 IP 共享，未认证接口容易被限流），或语言统计被 CSS/HTML 抢占时，
  // 从依赖清单回推一个更可信的主语言
  let displayLang = (meta && meta.language) || '';
  if (!displayLang || /^(css|html|scss|less|sass|stylus)$/i.test(displayLang)) {
    const real = stack.find((s) =>
      /java|kotlin|python|golang|go$|rust|php|ruby|typescript|javascript|node|\.net|c#/i.test(s.name)
    );
    if (real) displayLang = /node/i.test(real.name) ? 'JavaScript' : real.name.replace(/\s*\/.*$/, '');
  }
  if (!displayLang) displayLang = '—';

  const brief = {
    repo: {
      fullName: meta ? meta.full_name : owner + '/' + repo,
      description: (meta && meta.description) || '(作者没有填写描述)',
      stars: meta ? meta.stargazers_count : null,
      language: displayLang,
      branch: (meta && meta.default_branch) || '—',
      updatedAt: meta ? meta.pushed_at : null,
      license: meta && meta.license ? meta.license.spdx_id : '未声明',
    },
    stats: { files: blobs.length, modules: modules.length, topExts },
    stack,
    modules,
    readFirst: pickReadFirst(blobs, found),
    firstTask: suggestFirstTask(blobs),
    questions: buildOpenQuestions(blobs, found, frameworks),
  };

  emit({ type: 'step', id: 'brief', status: 'done', detail: '简报已生成' });
  emit({ type: 'brief', data: brief });
}

/* ------------------------------ 路由 ------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  const pubRoot = path.join(ROOT, 'public');
  const filePath = path.join(pubRoot, p);
  if (filePath.indexOf(pubRoot) !== 0) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.url.indexOf('/api/analyze') !== 0) {
    serveStatic(req, res);
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let closed = false;
  req.on('close', () => {
    closed = true;
  });
  const emit = (obj) => {
    if (closed) return;
    res.write('data: ' + JSON.stringify(obj) + '\n\n');
  };

  try {
    const { owner, repo } = parseRepoInput(url.searchParams.get('repo'));
    emit({ type: 'start', repo: owner + '/' + repo });
    await analyze(owner, repo, emit);
  } catch (err) {
    emit({ type: 'error', message: err.message || '分析失败' });
  } finally {
    if (!closed) res.end();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Scout running on http://0.0.0.0:' + PORT);
});
