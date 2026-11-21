param([int]$X, [int]$Y, [int]$DelaySeconds = 3)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class RightClickHelper {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, IntPtr extra);
}
'@
[RightClickHelper]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
Start-Sleep -Seconds $DelaySeconds
[RightClickHelper]::SetCursorPos($X, $Y) | Out-Null
Start-Sleep -Milliseconds 600
[RightClickHelper]::mouse_event(0x0008, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 80
[RightClickHelper]::mouse_event(0x0010, 0, 0, 0, [IntPtr]::Zero)
