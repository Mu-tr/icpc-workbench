# 云端桌面版构建设计

## 目标

使用仓库现有的 Tauri 桌面架构和 GitHub Actions，在不安装本地 Rust/Visual Studio 工具链的情况下生成 Windows 安装包与便携版。

## 桌面架构

- `icpc-workbench.exe` 是 Tauri 原生窗口壳，不打开外部浏览器。
- `icpc-core.exe` 是随桌面程序启动的本地服务核心，只监听本机地址。
- 桌面壳自动探测核心端口并加载应用，关闭窗口时一并结束核心进程。
- SQLite 数据保存在本地；安装版和便携版沿用项目现有的数据迁移与备份规则。

## 构建与发布流程

1. 在本地运行类型检查、代码规范检查和全部测试。
2. 确认工作区干净且提交历史包含启动脚本、Typst 镜像回退及其设计记录。
3. 将 `master` 推送到 `origin`，触发现有 `.github/workflows/nightly-desktop.yml`。
4. GitHub Actions 在 MSVC 环境构建 Windows 核心、Tauri 壳和 NSIS 安装程序。
5. 工作流质量门禁或构建失败时不发布产物；成功时覆盖 `nightly` 预发布版本。
6. 从 `nightly` Release 下载 Windows 产物和 `checksums.sha256`，验证哈希后放入本地 `server/release`。

## 交付物

- `icpc-workbench-<版本>-x64-setup.exe`：Windows 安装包。
- `icpc-workbench.exe` 与 `icpc-core.exe`：便携版，必须放在同一目录。
- `checksums.sha256`：产物完整性校验文件。

## 错误处理

- 本地质量检查失败时停止推送，先修复问题。
- Git 推送因认证或权限失败时保留本地提交并报告具体阻塞点。
- 云端任务失败时读取 Actions 日志，修复后创建新提交并重新触发。
- 只有哈希验证通过的产物才作为最终交付物。

## 版本管理

- 设计和必要的构建修复使用独立 Git 提交。
- 不重写已有提交历史，不强制推送。
- 本轮使用 `nightly` 验证桌面产物；稳定后再另行创建正式版本标签。
