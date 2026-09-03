# 为 Action Editor 贡献代码

感谢参与 Action Editor。该软件会控制真实电机，普通界面缺陷也可能演变为机械安全问题，因此所有变更都应先在仿真模式验证。

## 开发环境

- Node.js 24.20.0 或更高兼容版本（建议使用 Node 24 LTS）；
- npm 11.19.0（Node 24.20.0 官方发行包自带）；
- Python 3.9 或更高版本，仅使用标准库；
- 真实 CAN 测试需要 Linux SocketCAN，普通开发和 CI 不需要 CAN 硬件。

```bash
npm ci
npm run verify
npm start
```

打开软件后勾选“仿真”即可在不访问 SocketCAN 的情况下检查界面和动作流程。

除非提交时另有明确书面说明，主动提交到本项目的贡献按 [Apache License 2.0](LICENSE)
第 5 节所述条款提供。

## 变更要求

- 不要暴露原始 Electron IPC、文件系统、网络或任意桥接指令；
- 不要绕过 `main.js` 中的参数校验和操作白名单；
- 修改 MOVE、ACK 重放、STOP、DISABLE、FIFO 或会话切换逻辑时必须增加回归测试；
- 配置和时间轴 JSON 使用版本化格式。新增字段时需要旧版本迁移或明确拒绝策略；
- 功能、参数或使用流程变化时，同时更新 `README.md` 与 `README_EN.md`，保持中英文内容一致；
- 不要在测试、文档或提交中加入真实设备密钥、个人路径、导出的用户动作文件或电机参数；
- 不要让公共 CI 或外部 Pull Request 自动访问连接真实机器人的自托管 Runner。

提交 Pull Request 前请运行 `npm run verify`，并在说明中写明仿真测试和硬件安全措施。
