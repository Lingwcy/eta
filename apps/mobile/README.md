# eta-mobile

Eta 的 iOS / Android 应用，通过 HTTP 和 SSE 直接连接 Eta Bot。手机不运行 agent，也不依赖 `@eta/core`、`@eta/agent` 或 Desktop。

在仓库根目录安装依赖并启动 Expo：

```sh
vp install
vp run dev:mobile
```

使用支持当前 Expo SDK 的 Expo Go 扫描开发服务器的二维码。手机需要能够访问开发服务器和 Bot；服务器地址应填写手机可访问的域名或局域网地址，手机上的 `localhost` 指向手机自身。原生安装包默认使用 HTTPS；局域网 HTTP 开发连接使用 Expo Go。

应用启动后填写 Bot 地址和访问令牌。模型凭据需提前在 Bot 上配置，或通过 Desktop 导入。用户操作说明见 [连接与会话](../../docs/user/mobile.md)。

也可以在 Mac 上通过 Android Emulator 测试。安装模拟器并创建 Android 虚拟设备后，在仓库根目录运行：

```sh
export ANDROID_HOME="$HOME/Library/Android/sdk"
vp run eta-mobile#dev -- --android --localhost
```

将 `ANDROID_HOME` 配置到终端启动文件（如 `~/.zshrc`）后，无需每次手动设置。Expo 自动启动模拟器需要这个变量，或将 SDK 的 `emulator` 目录加入 `PATH`。

Expo 会打开虚拟设备、安装匹配 SDK 的 Expo Go 并加载应用。修改 TypeScript 和界面代码时，Fast Refresh 会更新运行中的应用；新增原生模块或修改原生配置时仍需重新构建安装包。模拟器连接 Bot 时，填写与手机相同的局域网地址和访问令牌。

运行 mobile 范围内的验证：

```sh
vp run eta-mobile#typecheck
vp run eta-mobile#test
vp run build:mobile
vp run eta-mobile#verify-package
```

`build:mobile` 导出 Android 和 iOS 的生产 JavaScript / Hermes 产物，不生成 APK 或 IPA。原生构建需要对应的 Android SDK / JDK 或 Xcode：

```sh
vp run eta-mobile#android
vp run eta-mobile#ios
```

`eas.json` 提供 Android APK、iOS 模拟器预览和商店构建配置。使用 EAS 前需要维护者自己的 Expo 项目及账号配置；真机 iOS 分发还需要签名凭据。移动端构建与现有 Desktop tag 发版流程独立。

macOS 本机构建可离线启动的 ARM64 Android 测试安装包，先安装 JDK 17、Android SDK 36、Build Tools 36.0.0、NDK 27.1.12297006 和 CMake 3.22.1，再从仓库根目录运行：

```sh
export ANDROID_HOME="$HOME/Library/Android/sdk"
export JAVA_HOME="$(/usr/libexec/java_home -v 17)"
cd apps/mobile
vp exec expo prebuild --platform android --no-install
cd android
NODE_ENV=production ./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a
```

产物在 `android/app/build/outputs/apk/release/app-release.apk`，内置生产 Hermes 产物，使用 Expo 模板的测试签名。商店发布使用 EAS production 配置及正式签名。这里的离线启动只表示不依赖 Expo 开发服务器，执行任务仍需连接 Bot。
