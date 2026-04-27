using eDrawings.Interop.EModelViewControl;
using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

namespace NotionBackend.CadConversion
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            var options = Options.Parse(args);

            if (options.ShowHelp)
            {
                Console.WriteLine("Usage: EdrawingsStlExporter.exe --input file.sldprt --output file.stl [--timeout-ms 600000]");
                Console.WriteLine("       EdrawingsStlExporter.exe --health [--timeout-ms 15000]");
                return 0;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            try
            {
                if (options.Health)
                {
                    using (var form = new HealthForm(options.TimeoutMs))
                    {
                        Application.Run(form);
                        return form.ExitCode;
                    }
                }

                if (string.IsNullOrWhiteSpace(options.InputPath) || !File.Exists(options.InputPath))
                {
                    Console.Error.WriteLine("Input CAD file does not exist.");
                    return 1;
                }
                if (string.IsNullOrWhiteSpace(options.OutputPath))
                {
                    Console.Error.WriteLine("Output STL path is required.");
                    return 1;
                }

                Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(options.OutputPath)));

                using (var form = new ExportForm(options.InputPath, options.OutputPath, options.TimeoutMs))
                {
                    Application.Run(form);
                    return form.ExitCode;
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine(ex.Message);
                return 1;
            }
        }
    }

    internal sealed class Options
    {
        public bool Health { get; private set; }
        public bool ShowHelp { get; private set; }
        public string InputPath { get; private set; }
        public string OutputPath { get; private set; }
        public int TimeoutMs { get; private set; } = 600000;

        public static Options Parse(string[] args)
        {
            var options = new Options();
            for (var i = 0; i < args.Length; i++)
            {
                var arg = args[i];
                switch (arg)
                {
                    case "--health":
                        options.Health = true;
                        break;
                    case "--help":
                    case "-h":
                        options.ShowHelp = true;
                        break;
                    case "--input":
                        options.InputPath = RequireValue(args, ref i, arg);
                        break;
                    case "--output":
                        options.OutputPath = RequireValue(args, ref i, arg);
                        break;
                    case "--timeout-ms":
                        if (int.TryParse(RequireValue(args, ref i, arg), out var timeoutMs))
                        {
                            options.TimeoutMs = Math.Max(5000, timeoutMs);
                        }
                        break;
                }
            }
            return options;
        }

        private static string RequireValue(string[] args, ref int index, string name)
        {
            if (index + 1 >= args.Length)
            {
                throw new ArgumentException(name + " requires a value.");
            }
            index += 1;
            return args[index];
        }
    }

    internal sealed class ExportForm : HiddenEdrawingsForm
    {
        private readonly string inputPath;
        private readonly string outputPath;
        private EModelViewControl control;
        private bool saveStarted;

        public ExportForm(string inputPath, string outputPath, int timeoutMs) : base(timeoutMs)
        {
            this.inputPath = Path.GetFullPath(inputPath);
            this.outputPath = Path.GetFullPath(outputPath);
        }

        protected override void OnControlLoaded(EModelViewControl ctrl)
        {
            control = ctrl;
            control.OnFinishedLoadingDocument += OnFinishedLoadingDocument;
            control.OnFailedLoadingDocument += OnFailedLoadingDocument;
            control.OnFinishedSavingDocument += OnFinishedSavingDocument;
            control.OnFailedSavingDocument += OnFailedSavingDocument;
            control.OpenDoc(inputPath, false, false, true, "");
        }

        private void OnFinishedLoadingDocument(string fileName)
        {
            saveStarted = true;
            control.Save(outputPath, false, "");
        }

        private void OnFailedLoadingDocument(string fileName, int errorCode, string errorString)
        {
            Fail(2, "eDrawings failed to load '" + fileName + "': " + errorString + " [" + errorCode + "]");
        }

        private void OnFinishedSavingDocument()
        {
            var output = new FileInfo(outputPath);
            if (!output.Exists || output.Length <= 0)
            {
                Fail(3, "eDrawings reported success but did not create a readable STL file.");
                return;
            }

            Succeed("STL export completed: " + outputPath);
        }

        private void OnFailedSavingDocument(string fileName, int errorCode, string errorString)
        {
            Fail(3, "eDrawings failed to export STL: " + errorString + " [" + errorCode + "]");
        }

        protected override void OnTimedOut()
        {
            Fail(4, saveStarted ? "Timed out waiting for eDrawings STL export." : "Timed out waiting for eDrawings to load the CAD file.");
        }

        protected override void OnClosing()
        {
            try
            {
                control?.CloseActiveDoc("");
            }
            catch
            {
                // Closing is best effort during process shutdown.
            }
        }
    }

    internal sealed class HealthForm : HiddenEdrawingsForm
    {
        public HealthForm(int timeoutMs) : base(timeoutMs)
        {
        }

        protected override void OnControlLoaded(EModelViewControl ctrl)
        {
            Succeed("eDrawings ActiveX control loaded.");
        }

        protected override void OnTimedOut()
        {
            Fail(4, "Timed out waiting for eDrawings ActiveX control.");
        }
    }

    internal abstract class HiddenEdrawingsForm : Form
    {
        private readonly Timer timer;
        private readonly DateTime deadline;
        private bool completed;

        public int ExitCode { get; private set; } = 1;

        protected HiddenEdrawingsForm(int timeoutMs)
        {
            deadline = DateTime.UtcNow.AddMilliseconds(Math.Max(5000, timeoutMs));
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            Location = new Point(-32000, -32000);
            Size = new Size(800, 600);
            Text = "eDrawings CAD Exporter";

            timer = new Timer { Interval = 500 };
            timer.Tick += delegate
            {
                if (DateTime.UtcNow >= deadline)
                {
                    OnTimedOut();
                }
            };
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            timer.Start();

            try
            {
                var host = new EdrawingsHost();
                host.ControlLoaded += OnControlLoaded;
                host.Dock = DockStyle.Fill;
                Controls.Add(host);
            }
            catch (Exception ex)
            {
                Fail(1, "Failed to create eDrawings ActiveX control: " + ex.Message);
            }
        }

        protected void Succeed(string message)
        {
            Console.WriteLine(message);
            Complete(0);
        }

        protected void Fail(int exitCode, string message)
        {
            Console.Error.WriteLine(message);
            Complete(exitCode);
        }

        private void Complete(int exitCode)
        {
            if (completed)
            {
                return;
            }

            completed = true;
            ExitCode = exitCode;
            timer.Stop();
            OnClosing();
            BeginInvoke(new Action(Close));
        }

        protected virtual void OnClosing()
        {
        }

        protected abstract void OnControlLoaded(EModelViewControl ctrl);
        protected abstract void OnTimedOut();
    }

    internal sealed class EdrawingsHost : AxHost
    {
        private const string VersionIndependentViewControlClsid = "22945A69-1191-4DCF-9E6F-409BDE94D101";
        private bool loaded;

        public event Action<EModelViewControl> ControlLoaded;

        public EdrawingsHost() : base(VersionIndependentViewControlClsid)
        {
        }

        protected override void OnCreateControl()
        {
            base.OnCreateControl();
            if (loaded)
            {
                return;
            }

            loaded = true;
            var ctrl = GetOcx() as EModelViewControl;
            if (ctrl == null)
            {
                throw new InvalidOperationException("Could not access eDrawings EModelViewControl.");
            }
            ControlLoaded?.Invoke(ctrl);
        }
    }
}
