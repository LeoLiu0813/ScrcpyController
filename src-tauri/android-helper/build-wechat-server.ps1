#requires -Version 7.4
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

# Requires Android SDK platform 36, build-tools 36.0.0, and a JDK.
$build = Join-Path ([IO.Path]::GetTempPath()) ("wechat-server-" + [guid]::NewGuid())
$checkout = Join-Path $build 'scrcpy'
$gen = Join-Path $build 'gen'
$classes = Join-Path $build 'classes'
$platform = Join-Path $env:ANDROID_HOME 'platforms/android-36'
$tools = Join-Path $env:ANDROID_HOME 'build-tools/36.0.0'
New-Item -ItemType Directory -Path "$gen/com/genymobile/scrcpy", $classes | Out-Null
git clone --depth 1 --branch v5.0.1 https://github.com/Genymobile/scrcpy.git $checkout
if ((git -C $checkout rev-parse HEAD) -ne 'a60891aea193d92e7e5c3942700eca63f9d19a5f') {
    throw 'Unexpected scrcpy revision'
}
git -C $checkout apply (Join-Path $PSScriptRoot 'wechat-server.patch')

@"
package com.genymobile.scrcpy;

public final class BuildConfig {
    public static final boolean DEBUG = false;
    public static final String VERSION_NAME = "5.0.1";
}
"@ | Set-Content "$gen/com/genymobile/scrcpy/BuildConfig.java"

$source = Join-Path $checkout 'server/src/main'
$aidl = (Resolve-Path "$source/aidl").Path
& "$tools/aidl.exe" "-o$gen" "-I$aidl" "$aidl\android\content\IOnPrimaryClipChangedListener.aidl"
& "$tools/aidl.exe" "-o$gen" "-I$aidl" -p (Resolve-Path "$platform/framework.aidl").Path "$aidl\android\view\IDisplayWindowListener.aidl"

Get-ChildItem "$source/java", $gen -Recurse -Filter '*.java' |
    ForEach-Object { '"' + $_.FullName.Replace('\', '/') + '"' } |
    Set-Content "$build/javac.txt"
& "$env:JAVA_HOME/bin/javac.exe" -encoding UTF-8 -bootclasspath "$platform/android.jar" `
    -classpath "$tools/core-lambda-stubs.jar" -d $classes -source 8 -target 8 "@$build/javac.txt"
& "$env:JAVA_HOME/bin/jar.exe" cf "$build/classes.jar" -C $classes .
& "$tools/d8.bat" --min-api 21 --lib "$platform/android.jar" --output "$build/wechat-server.zip" "$build/classes.jar"
Copy-Item -LiteralPath "$build/wechat-server.zip" -Destination (Join-Path $PSScriptRoot 'wechat-server.jar')
Write-Output "Build intermediates: $build"
