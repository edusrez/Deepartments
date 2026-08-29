# Deepartments

[English](README.md) | 中文

Deepartments 是**面向 DeepSeek Harness (DSH) 的智能体（agent）化组织层**——
部门、可休眠与唤醒的职位（post）、见证者（witness）、激活（activation）与治理
（governance）——以运行时的 **npm 插件（bundle）** 形式构建。旧工作区的理念在
这里具象化成了软件：DSH 回答事物*如何运行*（会话、子智能体、调度、技能、任务、
工具）；Deepartments 回答事物*如何组织*（职位、部门、智能体消息、见证者、激活、治理
策略究竟是什么）。

## 状态

- **第 2 阶段（MVP）开发中** —— 参见 [docs/ROADMAP.md](docs/ROADMAP.md)。
- **版本：** `0.1.0-rc.1`（包 `dsh-deepartments`）。
- **许可证：** MIT。
- **文档：** [docs/IDEA.md](docs/IDEA.md)（理念）·
  [docs/concept.md](docs/concept.md)（决策与映射）·
  [docs/ROADMAP.md](docs/ROADMAP.md)（阶段与启动事项）。

## 快速上手

```sh
dsh plugin --profile <x> add dsh-deepartments
```

将 bundle 安装到配置文件 `<x>` 中，并向运行时贡献其配置层与服务。开发使用隔离
的配置文件 `deepartments-dev`（参见 [AGENTS.md](AGENTS.md) —— TIERED
verification）。

## 文档

- **`docs/IDEA.md`** —— 重构后的理念：将智能体化组织作为 DSH 之上的一层，包含
  每个概念及其原生机制。
- **`docs/concept.md`** —— 决策记录（2026-08-16）以及已解决的 IDEA→DSH 映射、
  MVP 与风险。
- **`docs/ROADMAP.md`** —— 第 0-4 阶段及退出标准，以及第 2 阶段的启动任务。

## 开发

```sh
pnpm build         # `tsc` —— 将 src/ 编译到 lib/
pnpm build:client  # dshd-gui 拥有客户端构建 —— `pnpm --filter dshd-gui run build:client && node scripts/mirror-client.mjs` —— 在包内打包客户端插件，再字节级镜像到 ./client（bundle 的 R6 镜像）
pnpm test          # `node --test` —— 运行单元测试
```

验证是分层的（TIERED）—— 参见 [AGENTS.md](AGENTS.md) 了解各层级说明。

## 工作约定

要构建该插件：阅读 [AGENTS.md](AGENTS.md) 并加载技能
`dsh-plugin-dev`（`.dsh/skills/dsh-plugin-dev/SKILL.md`）。
