# 同映：本地电影同步放映

主机从电脑选择电影，朋友通过分享链接同步观看。主机端可以将 MKV 或不兼容的编码转换为 iPhone Safari 可直接播放的 MP4（H.264 + AAC）。

## 先理解 GitHub 在这里做什么

GitHub 用来保存、分享和更新这套程序，不负责保存或传输电影，也不能运行 FFmpeg。电影始终位于主机电脑，由主机电脑向观众传送。因此：

- 不要把电影文件提交到 GitHub；`data/` 已被忽略。
- 主机电脑必须在观影期间保持开机并运行本服务。
- 外网观众需要通过 Cloudflare Tunnel、Tailscale Funnel 或你自己的反向代理访问主机。
- 上行带宽决定观影质量。1080p 通常比保留 4K 更适合多人公网观看。

## Windows：最简单的运行方式

1. 在 PowerShell 中进入项目文件夹。
2. 首次运行 `./setup-windows.ps1`，它会通过 winget 安装 Node.js、FFmpeg 和 cloudflared。安装后重新打开 PowerShell。
3. 仅在同一 Wi-Fi 内观看时，运行 `./start-windows.ps1`；需要外网分享时，运行 `./start-windows.ps1 -Public`。浏览器会自动打开主机放映台。
4. 选择电影。MKV 文件请点击“开始转码”，等待 iPhone 版本就绪。

仅同一 Wi-Fi 内观看时，可以把终端显示的主机局域网地址与 `/watch/...` 路径组合后分享。

## 让外网朋友观看

推荐直接运行：

```powershell
./start-windows.ps1 -Public
```

脚本会建立临时 HTTPS 隧道，并在公网地址中打开主机页面，此时页面里的“复制”按钮会直接复制正确的公网观影链接。

也可以先运行普通启动脚本，再在另一个 PowerShell 窗口手动建立隧道：

```powershell
cloudflared tunnel --url http://localhost:3210
```

cloudflared 会显示一个形如 `https://xxxxx.trycloudflare.com` 的地址。把主机页面“邀请朋友入场”中的链接域名替换成这个 HTTPS 域名，保留 `/watch/后面的一长串字符`，再分享给朋友。

示例：

```text
本地链接：http://localhost:3210/watch/ABC123
分享链接：https://xxxxx.trycloudflare.com/watch/ABC123
```

临时隧道地址每次重启都会变化。正式长期使用时，可在 Cloudflare 控制台创建命名隧道并绑定自己的域名。

## macOS / Linux

先安装 Node.js 20+ 与 FFmpeg，然后：

```bash
npm install
npm start
```

浏览器打开终端打印的主机链接。要从公网访问，另开终端运行：

```bash
cloudflared tunnel --url http://localhost:3210
```

## Docker

```bash
docker compose up --build
```

然后访问 `http://localhost:3210`。电影和转换结果保存在 Docker volume `cinema-data` 中。

## 如何同步

- 主机的播放、暂停、拖动进度和倍速会通过实时连接广播。
- 观众每 2.5 秒自动校准一次，网络波动后也会回到主机时间。
- iPhone Safari 禁止未经触摸的有声自动播放，因此观众第一次进入时需要点一次“轻触加入同步播放”。
- 视频接口支持 HTTP Range，Safari 可以拖动进度而无需重新下载完整电影。

## 转码说明

推荐的“最高 1080p”输出为 H.264 High / yuv420p + AAC 双声道 MP4，兼容性最好。保留原分辨率会保留 4K 画面尺寸，但耗时、文件大小和上行带宽压力都明显更高。

如果 FFmpeg 不在系统 PATH，可复制 `.env.example` 的配置思路，在启动前设置：

```powershell
$env:FFMPEG_PATH = 'D:\ffmpeg\bin\ffmpeg.exe'
npm start
```

## 安全与版权

- 观影链接本质上是一把随机生成的访问钥匙；没有账户系统。只发给信任的人，泄露后请删除 `data/state.json` 并重启以生成新链接。
- 临时 Cloudflare Tunnel 会把本机服务暴露到互联网。观影结束后关闭 cloudflared 和本服务。
- 本项目不提供 DRM 绕过、盗版内容或公共分发功能。只播放你拥有版权或已获得授权的内容。
- 这不是大规模视频平台。每位观众都会占用主机一份上行带宽。

## 发布源码到 GitHub

在安装 Git 后，从项目目录执行：

```bash
git init
git add .
git commit -m "Initial local watch-together app"
git branch -M main
git remote add origin https://github.com/你的用户名/你的仓库名.git
git push -u origin main
```

仓库应只包含程序源码。GitHub Pages 只能托管静态文件，不能执行本项目的 Node.js 服务和 FFmpeg，所以不要把 Pages 当作视频服务器。
