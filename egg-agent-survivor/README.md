# Egg Agent Survivor

浏览器原生的 Roguelike 生存射击游戏，无需安装运行时依赖。

## 快速启动

环境要求：

- Python 3（启动静态开发服务器）
- Node.js 18+（运行自动化探针）

在项目目录中运行：

```bash
cd egg-agent-survivor
npm run dev
```

然后打开 <http://localhost:3000>。

也可以使用一键脚本，并按需覆盖监听地址和端口：

```bash
./scripts/dev-server.sh
HOST=127.0.0.1 PORT=4173 ./scripts/dev-server.sh
```

## 自动化探针

```bash
npm run probe
```

探针会验证项目必需文件、HTML 中的本地资源引用、JavaScript 入口文件，并对项目内全部 JavaScript 文件执行 `node --check`。任何检查失败时命令会以非零状态退出。
