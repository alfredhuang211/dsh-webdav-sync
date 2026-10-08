# dsh-webdav-sync

把 DSH 的**会话日志**和**插件环境**同步到任意 WebDAV 服务，带版本号 / 时间 / 设备溯源，可增量备份与恢复。零运行时依赖（Node 内置 `zstd` + `fetch`），host + 客户端两半齐全，Desktop 与 CLI 都能用。

> 仓库内的参考实现（v0.2.1），已在真实 `dsh` 0.2.0-rc.1 的 web profile 上跑通双源同步、版本溯源、冲突处理与强制恢复。

## 它同步什么

| 源 | 内容 | 说明 |
| --- | --- | --- |
| **会话** | `$DSH_HOME/sessions/**/*.jsonl.zstd` | 字节级；恢复时按日志头部的 `cwd` 重算落位目录 |
| **插件环境** | profile 的 `package.json`、`cordis.patch.yml`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`$DSH_HOME/cordis.patch.yml`（可选）、插件市场状态（可选） | 这些才是"环境真身"；`node_modules` 是可重装的产物，**永不同步** |
| **插件清单** | 自动生成的 `environment/inventory.json` | 每个插件的**名称 + 版本 + 启用状态**——宿主自带的清单 API 不含版本号，所以版本是插件自己从 `node_modules` 里读的 |

## 版本机制：怎么知道哪一份是最新的

远端 `manifest.json` 是 v2 结构，每个文件都带三层信息：

```json
{
  "schema": 2,
  "generation": 12,                      // 整份备份的代号，有变化才 +1
  "updatedAt": "2026-09-30T10:12:54.873Z",
  "device": { "id": "dev-98597ad2", "label": "sandbox-mac", "platform": "darwin" },
  "devices": { "dev-98597ad2": { "label": "sandbox-mac", "lastSeen": "..." } },
  "entries": {
    "sessions/--Users-me-proj--/sess-x/session.v4.jsonl.zstd": {
      "sha1": "…", "size": 12933,
      "rev": 3,                            // 逻辑版本号：内容变了才 +1
      "updatedAt": "2026-09-30T09:02:08.000Z",  // 源文件时间
      "device": "dev-98597ad2"             // 最后写入者
    }
  }
}
```

判定规则（`lib/versioning.js`）：

1. `sha1` 相同 → 一致，什么都不做；
2. 本机存有 `base`（上次同步的共同祖先）时：只有一端变了 → 直接推进那一端，**不是冲突**；
3. 两端相对 base 都变了 → **冲突**，按 `conflictPolicy` 取舍：
   - `prefer-newer`（默认）：先比 `rev`，再比 `updatedAt`，最后用 `device` 字典序收敛（保证两端算出同一结果，不会来回覆盖）；
   - `keep-local` / `keep-remote` / `keep-both` / `manual`；
4. 落败的一方默认另存为 `.conflict-<设备>-r<版本>` 副本，**绝不静默丢弃**。

## 安全红线

- push / pull **都不删除本机会话**；
- 恢复覆盖的条件是"本机相对 base 没改过"（覆盖不丢东西）；本机改过的文件必须显式开启 `pullOverwrite` 或走「以云端为准」（`POST /pull?force=1`）；
- 环境文件被覆盖前先写 `.bak-<时间戳>`；
- 运行中的会话不参与覆盖；
- **同步两侧都剥离本插件自身的配置行**：否则换机恢复后会把 WebDAV 同步目标改回旧机器；恢复时本机那一行会被保留（换机后你重新填的地址不会被云端旧值抹掉）；
- 永不触碰 `node_modules`。

## 配置界面（已实测渲染）

**设置 → WebDAV 同步**，三组表单（连接 / 同步内容 / 版本与冲突）+ 状态面板：

```
连接      可达
本机      sandbox-mac
云端      第 2 代，2026/9/30 18:13:39 由 sandbox-mac 写入，10 个文件
差异      待上传 0，待恢复 0，冲突 0，一致 10
插件清单对照：一致
```

按钮：保存 / 状态/版本 / 测试连接 / 预演 / 立即备份 / 从云端恢复 / 以云端为准 / 安装依赖。

命令行也可用：`/webdav-sync push|pull|plan|status|test|install`（`pull force` = 以云端为准）。

## 环境恢复后的最后一步

恢复 `package.json` / `pnpm-lock.yaml` 之后需要重装依赖：

- 界面上点「安装依赖」，或命令 `/webdav-sync install`；
- 它调用 `ctx.profileContext.packageManager`（打包版用内置 pnpm、开发版用 PATH 里的 pnpm），在 profile 目录里执行 `install`；
- 等价手工命令：`cd $DSH_HOME/profiles/<profile> && pnpm install`。

## 测试

```bash
pnpm install   # 只为 @deepseek-ai/schemastery
node --test test/*.test.mjs
```

42 个用例：版本排序与三方比较矩阵、WebDAV 客户端路径与建目录（含 basePath 非空）、全新 state 面对已有云端的 base 落下、`nextRev`、v1 清单兼容、环境发现与清单版本、自指剥离、冲突各策略、双源端到端、force 恢复、恢复后收敛性（不抖动）、运行中会话跳过、鉴权失败。

## 目录结构

```
lib/index.js       入口：name/inject/Config/apply；接 profileContext、路由、命令、定时器、依赖安装
lib/config.js      schemastery Config（.volatile() 子树决定哪些字段可被设置页写回）+ 到引擎配置的映射
lib/versioning.js  版本机制核心：compareVersion / decide（三方比较）/ nextRev / manifest v1→v2 归一化
lib/state.js       本机状态：设备 ID、base 三方基准、sha1 缓存
lib/env.js         环境采集：声明文件发现、插件清单（含版本）、patch 解析与自指剥离、清单 diff
lib/layout.js      复刻宿主的 encodeSegment / projectKey / 日志识别 / 流式读 header
lib/webdav.js      零依赖 WebDAV 客户端（Basic / MKCOL / PUT / GET / PROPFIND / DELETE）
lib/sync.js        同步引擎：双源、manifest v2、冲突副本、原子写、force 恢复
lib/routes.js      同源 HTTP 路由（首行过 ctx.connection.requestRejection 信任栅栏）
client/bundle.js   浏览器半边：window.__ModuleLoader__ 自注册 + settings.section 表单
test/              42 个用例
```

## 安装

```bash
# 已发布到 npm 后（CLI 的 web / 自定义 profile）
dsh plugin --profile web add dsh-webdav-sync

# 直接从 GitHub 源码装（pnpm 的 git 协议，会按本地源码构建/链接）
dsh plugin --profile web add github:alfredhuang211/dsh-webdav-sync
```

**Desktop**：`desktop` profile 由 Electron 托管，CLI 拒绝操作，必须走 App 内的插件市场。`package.json` 已按市场契约声明 `engines.dsh` 与 `@deepseek-ai/*` peer。

## 仓库

源码：<https://github.com/alfredhuang211/dsh-webdav-sync>（MIT）

开发指引与踩坑记录另见上层文档《DSH插件开发指南-WebDAV会话同步.md》，本仓库只放插件本身。
