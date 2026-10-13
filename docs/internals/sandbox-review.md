# 沙盒审查的授权边界

审批改变决定者，不改变沙盒边界。[授权扩展](../../packages/core/src/service/runtime/approvals.ts)计算范围并保存请求，[运行时](../../packages/core/src/service/runtime/index.ts)按工具 task 和沙盒 revision 找到批准，再打开带该范围的执行环境。审查模型只能决定这份范围，不能自行增加路径。凭证目录和 Eta 数据目录的限制仍由实际沙盒执行。

审查器需要独立的只读环境。如果借用等待批准的工具环境，会提前获得尚未批准的外部路径；如果走 agent 的工具注册，又会递归触发审批。它因此直接使用[固定工具](../../packages/core/src/service/runtime/review-tools.ts)，只开放 workspace 与已核对的本仓库 common directory，禁用网络。文件路径经过 canonicalPath 核对；Git 查询额外关闭 ext-diff、textconv 与 fsmonitor，避免“查询”执行仓库提供的程序。模型请求、模型可用性检查与工具执行共享同一取消期限，超时后的结果不进入批准。

Linked worktree 的 index / HEAD 和共享对象、分支 ref 位于 workspace 外。[Git 元数据展开](../../packages/core/src/service/git/metadata.ts)精确开放这些目录，是因为 Landlock 的授权只能叠加，不能开放父目录后再排除 config、hooks 或其他 worktree。分支 ref 需要在同目录创建锁，所以授权不可避免地覆盖该目录里的兄弟分支；对象库也由所有 worktree 共享。这正是运行内授权需要在客户端明确说明风险的原因。

运行内复用复用的是范围，不是命令判断。同 conversation、同 revision、同一组展开目录且没有额外路径或联网申请时，Core 为每次调用写独立的批准记录；根运行空闲或停止即清除授权。切回人工审批永久撤销自动审查发出的复用，保留用户自己批准的复用；再次开启自动审查不能恢复旧授权。模型晚到的结论不能覆盖用户已经作出的决定，未完成审查恢复时转交用户，防止重启后重新执行旁路审查。
