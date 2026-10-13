# Git 工作区的宿主边界

Core、Desktop 和 Bot 共用 Git 服务，但执行目录和 GitHub 身份属于各自宿主。客户端只传 workspace / project 标识：[Git 查询](../../packages/core/src/service/git/index.ts)核对额外 workspace 与项目根的 common directory，[GitHub 查询](../../packages/core/src/service/git/github.ts)从项目根及保存的 remote 选择确定 owner / repo。会话展示归属可以改变，执行工作区不能随之迁移；右侧栏必须沿 thread.workspaceId 回到项目，避免查询错误仓库。

[宿主 Git 适配器](../../packages/core/src/platform/git.ts)关闭 hooks、fsmonitor、外部 diff 与 credential helper。即使 agent 可以写主 checkout 的配置，宿主的状态查询与 worktree 创建也不能执行其中提供的程序。GitHub 使用独立的[只读网络适配器](../../packages/core/src/platform/github.ts)，优先复用 GitHub CLI 登录，并为一次查询固定凭据；身份变化使缓存失效。返回客户端的身份 revision 是随机值，不包含 token 或其散列。

Desktop 的默认 worktree 管理根位于 `<dataRoot>-worktrees`，作为受保护数据目录的同级目录。放在 dataRoot 内会让目录授权与数据目录的禁止规则冲突：不能为了开发目录而放开设置、凭证与会话记录。此调整于 2026-10-13 获维护者确认。Bot 独立指定 workspaceRoot/.eta-worktrees，项目扫描继续跳过隐藏目录。

创建与移除的 Git / 文件系统副作用无法和会话存储一起提交事务，故[生命周期服务](../../packages/core/src/service/git/worktrees.ts)先保存意图和 requestId，重试及 reconcile 根据真实 Git 状态核对。[执行保护](../../packages/core/src/service/git/workspace-access.ts)在移除期间阻止新执行认领，持久墓碑在旧路径被重新创建时也继续阻止执行；旧会话保持历史，接续必须创建新的 workspace / thread。进程内保护不是跨进程锁，外部 Git 与另一宿主仍依赖 Git 原生锁和操作后核对。
