param([int]$X, [int]$Y, [int]$DelaySeconds = 3)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class ClickHelper {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, IntPtr extra);
}
'@
[ClickHelper]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
Start-Sleep -Seconds $DelaySeconds
[ClickHelper]::SetCursorPos($X, $Y) | Out-Null
Start-Sleep -Milliseconds 600
[ClickHelper]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 80
[ClickHelper]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
