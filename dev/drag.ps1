$ErrorActionPreference = 'Stop'
Start-Sleep -Seconds 3
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class MouseDrag {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, IntPtr extra);
}
'@
[MouseDrag]::SetCursorPos(400, 300) | Out-Null
Start-Sleep -Milliseconds 250
[MouseDrag]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 120
for ($i = 1; $i -le 12; $i++) {
    [MouseDrag]::SetCursorPos(400 + $i * 40, 300 + $i * 25) | Out-Null
    Start-Sleep -Milliseconds 25
}
Start-Sleep -Milliseconds 120
Start-Sleep -Seconds 2
[MouseDrag]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
