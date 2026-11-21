param([string]$Out)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing, System.Windows.Forms @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public class Snap {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public static void Save(string path) {
    SetProcessDPIAware();
    Rectangle area = SystemInformation.VirtualScreen;
    using (Bitmap bitmap = new Bitmap(area.Width, area.Height))
    using (Graphics graphics = Graphics.FromImage(bitmap)) {
      graphics.CopyFromScreen(area.X, area.Y, 0, 0, bitmap.Size);
      bitmap.Save(path, ImageFormat.Png);
    }
  }
}
'@
[Snap]::Save($Out)
