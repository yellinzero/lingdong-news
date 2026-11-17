# 版本与发布

简体中文 · [English](en/releasing.md)

## 修改版本

```sh
pnpm version:set 0.1.1
pnpm version:check
```

`VERSION` 使用 `X.Y.Z` 格式；命令同步更新各配置文件和中英文 README。

## 发布

启用 GitHub Actions，使用仓库自带的 `GITHUB_TOKEN`。

| 触发 | 执行 |
| --- | --- |
| 只修改 README、docs 或来源说明文档 | 检查版本和文档链接，不重新打包 |
| 程序、依赖或构建配置变更，或手动运行 Desktop CI | 完整测试和三端构建 |
| 更新 VERSION 并合并到 main，或手动运行 Stable release | 检查通过后创建 `vX.Y.Z` tag，发布稳定 Release |

Release 包含 macOS 通用 `.dmg`、Windows x64 `.exe`、Linux x64 `.deb` / `.AppImage` 及 `SHA256SUMS`。

已发布的版本必须升版；失败时可重跑 Actions。
