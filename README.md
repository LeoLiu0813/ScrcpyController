# 安卓控制台

面向 Windows（微软桌面系统）的本地控制台，使用 Tauri（桌面应用框架）、React（界面组件库）和 TypeScript（带类型检查的编程语言）。

支持暗色透明界面、固定图标导航、简体中文与英语，以及多台手机的独立投屏窗口。本机同时运行一个控制台实例，可以控制多台手机。双击在线设备打开投屏，再次打开聚焦现有窗口。点击停止关闭对应会话。在设备页底部添加设备、刷新列表或批量删除，批量删除支持全选。无线配对地址与连接地址分别填写。设备行还提供锁屏、无线接入与断开、设备设置和删除入口。

## 外观和设备管理

在「设置 → 外观」即时调整窗口底色和面板的不透明度。主窗口使用自定义标题栏，左侧栏独立于滚动的内容面板。

品牌图标默认根据手机报告的厂商识别。在设备设置中编辑名称、品牌图标和数字角标，名称按回车保存，通过拖动设备行手柄排序。点击侧栏设置上方的手机图标选择当前设备，工具和独立应用页共用这个选择。数字角标仅在确有多台同厂商手机时显示。

名称、品牌设置、投屏配置、独立应用快捷项及窗口记忆按已核实的设备码保存在本机，有线与无线切换、无线端口变化后沿用同一设备资料。同一手机的多个连接在设备页和托盘合并显示。无法核实归属的旧网络地址资料会保留，供后续恢复。

品牌图标来自 [Simple Icons（品牌图标集合）14.15.0](https://www.npmjs.com/package/simple-icons/v/14.15.0)，品牌标识归各权利人所有。

## 投屏配置与工具

投屏配置位于每台设备的设置中，图标侧栏区分资料、画质、声音、录像、窗口、输入与来源、剪贴板与文件、启动参数。声音默认由手机播放，声音路由在启动前设置。启动位置和尺寸分行显示，未指定时沿用上次位置与大小。启动参数可编辑，预览与实际启动共用生成逻辑。参数参考从当前引擎帮助输出读取，附中文说明。

查询、录制、声音、摄像头、文件和控制工具分别位于主侧栏。支持后台录制、仅声音、仅控制或有线免调试键鼠任务。后台录像在 3 至 300 秒内定时结束，录像存入系统视频目录下的控制台子目录。高级选项是否可用取决于手机及官方引擎版本。键鼠映射编辑功能已移除，保留官方输入模式及仅控制工具。

从侧栏打开「独立应用窗口」。每台手机的应用列表首次加载后会缓存在本机，安装或卸载应用后可手动刷新。用加号添加应用快捷项。图标从手机读取，左键打开，右键菜单提供编辑和删除。固定模式提供原屏尺寸、原屏一半、常用比例与自定义宽高，也可选择跟随窗口。固定分辨率可填写宽高，跟随窗口模式会随电脑窗口实时调整手机虚拟屏。同一手机的同一应用以相同设置再次打开时聚焦已有窗口。变更模式或固定宽高前，请先关闭该应用窗口。

添加应用时在选择框内直接搜索应用名或包名，默认采用原屏分辨率。抖音和微信的虚拟屏兼容处理以官方引擎 5.0.1 为已验证组合，启用时会校验手机端服务版本，其他版本可能需要通过普通投屏打开应用。

## 手机窗口与外观

普通投屏和独立应用窗口使用相同的透明外框、自定义标题栏及右侧快捷栏。标题栏提供置顶、收起侧栏、最小化、最大化和关闭。帧率位于侧栏导航按钮上方，悬停说明显示在标题栏中间。

快捷图标可排序，并在侧栏和「更多」之间双向拖放。「更多」向外弹出，失去焦点后收起。独立应用快捷项位于侧栏下方，数量较多时可滚动。

「按原始像素显示」使用实际视频帧尺寸，超出显示器工作区时等比缩放并提示。窗口保留标题栏所需的最小尺寸，收起侧栏、适配画面及恢复尺寸后保持手机画面比例。

在「设置 → 外观」可调整主窗口与面板透明度、各类控件的尺寸和颜色，以及手机窗口透明度、按钮底色、圆角和画面外围留白。颜色使用圆形选色器，外观设置即时生效并保存。操作图标使用 Lucide（开源线性图标集）。

## 投屏引擎更新

「设置 → 投屏引擎更新」会在启动后自动检查官方稳定版，也可手动检查。选择「下载并安装」后，控制台用 GnuPG（签名验证工具）校验官方签名和压缩包哈希。安装支持已加入系统搜索路径的 GnuPG，也支持 Git for Windows（微软桌面系统版代码版本管理工具）默认安装目录中附带的版本。

校验通过的版本会暂存，等所有投屏和录制任务结束后自动启用。可在同一页面回退到更新前的版本。通过环境变量指定外部引擎目录时，由该目录的维护者负责更新。

需要代理时可使用系统代理或 `HTTPS_PROXY`（安全网页代理环境变量），`SCRCPY_CONTROLLER_UPDATE_PROXY`（控制台更新专用代理环境变量）优先级更高。

## 单文件发行版

下载[发布页](https://github.com/LeoLiu0813/ScrcpyController/releases)的 `ScrcpyController-v0.1.4-windows-x64.exe`（微软桌面系统 64 位可执行文件）并运行，无需安装控制台或启动开发服务。系统需有 WebView2（微软网页渲染运行库）。投屏使用本机管理的 scrcpy（官方投屏引擎）。首次使用可在「设置 → 投屏引擎更新」安装，也可按下方步骤放入已校验的引擎。通过界面下载安装需要 GnuPG（签名验证工具）。

用 `npm run tauri -- build --no-bundle`（构建单文件程序）复现。发行版同一个可执行文件也可带参数使用，例如 `--json tray status`（以结构化格式查询托盘状态）。

正式发行构建额外使用 `--remap-path-prefix`（编译路径替换）将本机构建账户和工作区路径替换为通用路径。公开历史中的提交及版本标签使用平台隐私邮箱，文档效果图使用示例连接信息。

## 本地开发

1. 从 [scrcpy（官方投屏工具）发行页](https://github.com/Genymobile/scrcpy/releases/latest) 获取对应架构的完整压缩包，按 [上游签名与哈希校验说明](https://github.com/Genymobile/scrcpy/blob/master/doc/verify-release.md) 验证。
2. 将压缩包内的文件解压至下面的应用引擎目录，保证投屏程序、安卓调试桥和手机端服务位于同一目录。也可设置 `SCRCPY_CONTROLLER_ENGINE_DIR`（引擎目录环境变量）为已校验发行包的绝对路径。

```text
%LOCALAPPDATA%\com.leoliu0813.scrcpycontroller\engine
```

3. 在手机上开启调试并完成授权，然后运行以下命令。

```powershell
npm ci
npm run tauri dev
```

Windows 下也可直接双击项目根目录的 [启动.cmd](<启动.cmd>)。脚本会自动进入项目目录，检查 Node.js、npm 和 Rust；缺少前端依赖时会执行 `npm ci --include=dev`，然后启动桌面开发版。请保持启动日志窗口打开，停止开发服务时按 `Ctrl+C`；失败时窗口会保留错误信息。

只检查环境、不安装依赖或启动窗口：

```powershell
.\启动.cmd --check
```

使用 `npm run build`（前端构建命令）检查类型并打包。需要复用现有调试桥时，可以通过 `ADB`（安卓调试桥环境变量）指定其绝对路径。默认使用官方压缩包自带的版本。

[第三版设计与覆盖清单](docs/design/v3/README.md)

## 命令行控制

在项目根目录构建两个程序：

```powershell
cargo build --manifest-path src-tauri/Cargo.toml --locked --bins
$controller = ".\src-tauri\target\debug\scrcpy-controller.exe"
& $controller --json devices
```

保持命令行程序与 `tauri-app.exe`（安卓控制台）在同一目录。命令行优先连接当前用户已运行的控制台。开发版启动时需要先运行 `npm run dev`（前端开发服务），也可直接使用项目的 `启动.cmd`。

```powershell
$serial = "<从 devices 列表取得的设备序列号>"
& $controller --json open $serial
& $controller --json focus $serial
$shot = (& $controller --json screenshot $serial | ConvertFrom-Json).result
& $controller --json tap $serial 100 200 $shot.width $shot.height
& $controller --json close $serial
```

- `devices`（列出设备）、`open`（打开或聚焦）、`focus`（聚焦已有窗口）和 `close`（关闭）与主窗口共用设备会话。
- `screenshot`（截图）和 `tap`（点击）使用手机主屏原始像素坐标。点击前会核对当前截图尺寸，尺寸变化时请重新截图。
- `--json`（结构化输出）将单行结果写入标准输出。退出码 `0` 为成功，`1` 为操作失败，`2` 为参数错误，`3` 为无法联系控制台。

### 投屏快捷栏

先用 `open`（打开投屏）启动目标设备的普通投屏窗口，再调用：

```powershell
& $controller --json toolbar $serial state
& $controller --json toolbar $serial more open
& $controller --json toolbar $serial drag screenshot more notifications
& $controller --json toolbar $serial drag screenshot rail fullscreen
& $controller --json toolbar $serial action screenshot
& $controller --json toolbar $serial action fullscreen
& $controller --json toolbar $serial exit-fullscreen
& $controller --json toolbar $serial key right # 向前台投屏发送方向右键
```

- `state`（读取状态）返回快捷栏布局、弹出方向、全屏状态以及外框和投屏画面的实际尺寸。
- `drag`（拖放）接收快捷项、目标区和可选的插入位置。目标区是 `rail`（右侧栏）或 `more`（更多菜单）。给出目标快捷项时插到它前面，省略时追加到末尾。
- `move`（移动）使用桌面物理像素坐标。`resize`（缩放）使用逻辑像素宽高。`minimize`（最小化）和 `restore`（还原）只影响指定设备窗口。
- `sidebar`（收起或展开侧栏）只影响指定设备的投屏窗口。`click-video`（点击投屏画面）使用从原生画面左上角开始的物理像素坐标，发送前会核对鼠标命中目标。
- `click-toolbar`（真实点击外框控件）使用宿主客户区的物理像素坐标，目标窗口须处于前台，命中控件须属于该宿主且位于手机画面之外。可用于验证点击侧栏和标题栏按钮后的焦点状态。
- `drag-window`（拖动标题栏）使用桌面物理像素偏移，仅在目标投屏窗口处于前台时操作。可用 `state`（读取状态）检查移动后的画面命中和输入焦点。
- `key`（真实桌面按键）支持 `left`（左）、`right`（右）、`up`（上）、`down`（下）、`backspace`（退格）、`enter`（回车）、`escape`（退出）和 `tab`（制表）。目标投屏必须允许控制、处于前台且键盘焦点位于原生视频，发送前核对设备身份。结果中的 `sent`（已发送）表示系统输入已注入，手机页面效果需要另行验证。独立应用窗口可通过 `app-toolbar`（应用快捷栏接口）调用相同操作。

### 系统托盘

右键菜单可打开主窗口、打开或聚焦在线手机的投屏，以及退出。双击托盘图标恢复主窗口。「设置 → 通用」可选择关闭主窗口时退出软件或隐藏到托盘。退出时回收本软件启动的会话。

命令行可以调用同一组托盘操作：

```powershell
& $controller --json tray status
& $controller --json tray hide
& $controller --json tray show
& $controller --json tray device $serial
& $controller --json tray exit
```
