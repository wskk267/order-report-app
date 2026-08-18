# Android APK 构建

## 方案结构

这个项目不是 Flutter 项目，而是一个原生 Android WebView 壳，前端业务页面和离线存储运行在 WebView 中。

- `android/app/src/main/java/com/orderreport/app/MainActivity.java`：Android 入口，加载内置页面。
- `android/app/src/main/AndroidManifest.xml`：网络权限、应用入口和 HTTPS 安全配置。
- `public/index.html`、`public/app.js`、`public/styles.css`：业务界面。
- `shared/domain.js`：报单、FIFO、退款比例、统计和同步操作的核心规则。
- `scripts/sync-android-assets.js`：把 `public/` 和 `shared/domain.js` 复制到 APK 的 `assets/`。
- `android/app/src/main/assets/`：APK 实际打包的静态资源，不要只修改这里；修改前端后重新执行资源同步。

## 准备环境

安装以下工具：

- Android Studio，包含 Android SDK Platform 35 和 Build Tools。
- JDK 17。
- Gradle 8.7 或 Android Studio 自带的 Gradle。
- Node.js 18.17 或更高版本。

确认环境：

```bash
java -version
node --version
adb version
gradle --version
```

如果使用 Android Studio，直接用 Android Studio 打开项目里的 `android/` 目录，等待 Gradle 同步完成即可。命令行构建时，确保 `ANDROID_HOME` 指向 Android SDK，例如：

```bash
export ANDROID_HOME="$HOME/Android/Sdk"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
```

## 生成 Debug APK

在项目根目录执行：

```bash
npm install
npm run android:assets
cd android
gradle assembleDebug
```

生成文件：

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

安装到 USB 调试设备：

```bash
adb devices
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

也可以在 Android Studio 中选择 `app` 配置并点击 `Build > Build APK(s)`。

## 生成 Release APK

正式发布需要自己的签名文件。签名文件不能提交到公开仓库：

```bash
keytool -genkeypair -v \
  -keystore order-report-release.jks \
  -alias order-report \
  -keyalg RSA -keysize 2048 -validity 10000
```

把签名配置写到本机的 `android/keystore.properties`，该文件已被 `.gitignore` 排除。然后在 Android Studio 的签名配置中选择这个密钥，或在 `android/app/build.gradle` 中增加 `signingConfigs` 后执行：

```bash
cd android
gradle assembleRelease
```

不要把 `.jks`、密码、`keystore.properties` 或已签名 APK 上传到公开 GitHub 仓库。

## 修改代码后的流程

涉及界面或业务规则时执行：

```bash
npm test
npm run android:assets
cd android
gradle assembleDebug
```

退款比例逻辑在 `shared/domain.js` 的 `addRefund` 和 `updateRefund` 中；Android 页面中的只读金额展示在 `public/app.js` 的 `refundEditor` 和 `updateRefundAmount` 中。资源同步脚本会把最新代码复制到 `android/app/src/main/assets/`，否则 APK 可能仍然包含旧页面。

## 服务器地址和同步令牌

APK 内置的是离线页面，不把真实服务器地址和令牌编译进公开源码。首次启动后，在 APP 的“设置”页面填写 HTTPS API 地址和本机 `runtime/sync-token` 内容。服务端默认监听 `127.0.0.1:3011`，可通过 Caddy/frpc 对外提供 HTTPS 地址。
