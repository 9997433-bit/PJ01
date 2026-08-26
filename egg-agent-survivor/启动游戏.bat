@echo off
chcp 65001 >nul
title Egg Agent Survivor
echo.
echo  ========================================
echo   Egg Agent Survivor - 弹壳特攻队风格
echo  ========================================
echo.
echo  正在启动本地服务器...
echo  浏览器将自动打开 http://127.0.0.1:8080
echo  关闭本窗口即可停止游戏
echo.

where python >nul 2>&1
if %errorlevel%==0 (
  start http://127.0.0.1:8080
  python -m http.server 8080
  goto :end
)

where python3 >nul 2>&1
if %errorlevel%==0 (
  start http://127.0.0.1:8080
  python3 -m http.server 8080
  goto :end
)

echo [错误] 未找到 Python，请先安装 Python 3
echo 或者直接用浏览器打开 index.html（部分功能可能受限）
pause

:end
