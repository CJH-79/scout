# Scout

输入一个公开 GitHub 仓库，生成一份接手简报：技术栈、代码地图、建议先读的文件、可以接手的第一个任务。

## 它解决什么

接手一个陌生仓库，最花时间的不是写代码，是搞清楚这个项目是什么、代码分布在哪、从哪看起。Scout 把这段压缩到几秒。

输入 `owner/repo`，它依次执行四步：

1. `github.list_files` — 拉源码包，解出完整目录树
2. `code.inspect_manifest` — 读 `pom.xml` / `package.json` / `requirements.txt` 等，识别技术栈
3. `code.trace_dependencies` — 统计目录分布，标注每层职责
4. `agent.compose_brief` — 按这个仓库的实际情况生成简报

输出包含：技术栈判断（附判断依据）、代码地图、建议先读的 3–5 个文件、可以接手的第一个任务、需要找人确认的信息缺口。

## 运行

零第三方依赖，Node 18+。

```bash
node server.js              # 默认 3000 端口
PORT=8080 node server.js    # 指定端口
```

打开 `http://localhost:3000`。

## 实现说明

**为什么不用 GitHub REST API**

第一版用 `/repos/{owner}/{repo}/git/trees` 拿目录树，部署上线后发现：未认证请求按出口 IP 限流（60 次/小时），云服务共用 IP，很快就被打满。改成拉 `codeload.github.com` 的 tar.gz 源码包，一次请求拿到全部文件，在内存里解析 tar（512 字节头 + 八进制 size 字段）。GitHub API 降级为可选，只用来取 star 和描述，失败就显示 `—`，不影响主流程。

**为什么最后一步是规则不是模型**

简报生成目前是确定性规则，不是 LLM 调用。这样每一步都可复现、零成本、演示时输出稳定，不会因为模型抖动给出不同结论。工具层接口保持不变，后续把这一步换成模型生成即可。

**技术栈判断的边界**

只从依赖清单判断，不扫代码。早期版本扫过代码片段，结果 README 里提到的技术名词被误判成实际依赖（例如一个纯静态页被识别出 Prisma + PostgreSQL），所以收回了。没有 manifest 的项目只能按文件类型给一个粗略判断。

**已知限制**

- 源码包超过 24MB 不处理，当前只覆盖中小型仓库
- 只读公开仓库，私有仓库需要 token，暂不支持
- 目录树为空的仓库会直接报错

## 结构

```
server.js           HTTP 服务、四个工具的实现、tar 解析
public/index.html   页面
public/app.js       SSE 接收与渲染
public/styles.css   样式
```

服务端用 SSE 把每一步的执行状态推给前端，所以能看到四个工具依次跑完，而不是等一个大结果。
