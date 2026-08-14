using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class AtdWindowsJobController
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const uint GENERIC_READ = 0x80000000;
    private const uint GENERIC_WRITE = 0x40000000;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const uint OPEN_EXISTING = 3;
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private const uint SYNCHRONIZE = 0x00100000;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint WAIT_OBJECT_0 = 0;
    private const uint WAIT_TIMEOUT = 258;
    private const uint STILL_ACTIVE = 259;
    private static readonly IntPtr PROC_THREAD_ATTRIBUTE_JOB_LIST = new IntPtr(0x0002000D);

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES
    {
        internal int nLength;
        internal IntPtr lpSecurityDescriptor;
        internal int bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        internal int cb;
        internal string lpReserved;
        internal string lpDesktop;
        internal string lpTitle;
        internal uint dwX;
        internal uint dwY;
        internal uint dwXSize;
        internal uint dwYSize;
        internal uint dwXCountChars;
        internal uint dwYCountChars;
        internal uint dwFillAttribute;
        internal uint dwFlags;
        internal short wShowWindow;
        internal short cbReserved2;
        internal IntPtr lpReserved2;
        internal IntPtr hStdInput;
        internal IntPtr hStdOutput;
        internal IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFOEX
    {
        internal STARTUPINFO StartupInfo;
        internal IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        internal IntPtr hProcess;
        internal IntPtr hThread;
        internal uint dwProcessId;
        internal uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FILETIME
    {
        internal uint dwLowDateTime;
        internal uint dwHighDateTime;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        internal long PerProcessUserTimeLimit;
        internal long PerJobUserTimeLimit;
        internal uint LimitFlags;
        internal UIntPtr MinimumWorkingSetSize;
        internal UIntPtr MaximumWorkingSetSize;
        internal uint ActiveProcessLimit;
        internal UIntPtr Affinity;
        internal uint PriorityClass;
        internal uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        internal ulong ReadOperationCount;
        internal ulong WriteOperationCount;
        internal ulong OtherOperationCount;
        internal ulong ReadTransferCount;
        internal ulong WriteTransferCount;
        internal ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        internal JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        internal IO_COUNTERS IoInfo;
        internal UIntPtr ProcessMemoryLimit;
        internal UIntPtr JobMemoryLimit;
        internal UIntPtr PeakProcessMemoryUsed;
        internal UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        internal long TotalUserTime;
        internal long TotalKernelTime;
        internal long ThisPeriodTotalUserTime;
        internal long ThisPeriodTotalKernelTime;
        internal uint TotalPageFaultCount;
        internal uint TotalProcesses;
        internal uint ActiveProcesses;
        internal uint TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFOEX startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(
        IntPtr attributeList,
        int attributeCount,
        int flags,
        ref IntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr attributeList,
        uint flags,
        IntPtr attribute,
        IntPtr value,
        IntPtr size,
        IntPtr previousValue,
        IntPtr returnSize);

    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength,
        IntPtr returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(
        IntPtr process,
        out FILETIME creation,
        out FILETIME exit,
        out FILETIME kernel,
        out FILETIME user);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageName(
        IntPtr process,
        uint flags,
        StringBuilder executableName,
        ref uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFile(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        ref SECURITY_ATTRIBUTES securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetStdHandle(int standardHandle);

    private static readonly object OutputLock = new object();
    private static readonly Queue<string> Commands = new Queue<string>();
    private static volatile bool InputClosed;
    private static string Secret;

    private static void Fail(string message)
    {
        throw new InvalidOperationException(message);
    }

    private static string RequiredEnvironment(string name)
    {
        string value = Environment.GetEnvironmentVariable(name);
        if (String.IsNullOrEmpty(value))
        {
            Fail("missing controller configuration");
        }
        return value;
    }

    private static string FullPath(string value)
    {
        return Path.GetFullPath(value).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
    }

    private static bool SamePath(string left, string right)
    {
        return String.Equals(FullPath(left), FullPath(right), StringComparison.OrdinalIgnoreCase);
    }

    private static void ValidateProfileArgument(string[] arguments, string expectedProfile, string profileSwitch)
    {
        int occurrences = 0;
        int matches = 0;
        for (int index = 0; index < arguments.Length; index += 1)
        {
            string argument = arguments[index];
            if (profileSwitch == "user-data-dir" &&
                argument.StartsWith("--user-data-dir=", StringComparison.OrdinalIgnoreCase))
            {
                occurrences += 1;
                string value = argument.Substring("--user-data-dir=".Length);
                if (SamePath(value, expectedProfile)) matches += 1;
            }
            else if (profileSwitch == "profile" &&
                (String.Equals(argument, "-profile", StringComparison.OrdinalIgnoreCase) ||
                 String.Equals(argument, "--profile", StringComparison.OrdinalIgnoreCase)))
            {
                occurrences += 1;
                if (index + 1 < arguments.Length && SamePath(arguments[index + 1], expectedProfile)) matches += 1;
            }
            else if (profileSwitch == "profile" &&
                (argument.StartsWith("-profile=", StringComparison.OrdinalIgnoreCase) ||
                 argument.StartsWith("--profile=", StringComparison.OrdinalIgnoreCase)))
            {
                occurrences += 1;
                string value = argument.Substring(argument.IndexOf('=') + 1);
                if (SamePath(value, expectedProfile)) matches += 1;
            }
        }
        if (occurrences != 1 || matches != 1)
        {
            Fail("browser profile argument was missing or ambiguous");
        }
    }

    private static string QuoteArgument(string argument)
    {
        if (argument.Length > 0 && argument.IndexOfAny(new char[] {' ', '\t', '\n', '\v', '"'}) < 0)
        {
            return argument;
        }
        StringBuilder quoted = new StringBuilder();
        quoted.Append('"');
        int backslashes = 0;
        foreach (char character in argument)
        {
            if (character == '\\')
            {
                backslashes += 1;
            }
            else if (character == '"')
            {
                quoted.Append('\\', backslashes * 2 + 1);
                quoted.Append('"');
                backslashes = 0;
            }
            else
            {
                quoted.Append('\\', backslashes);
                backslashes = 0;
                quoted.Append(character);
            }
        }
        quoted.Append('\\', backslashes * 2);
        quoted.Append('"');
        return quoted.ToString();
    }

    private static StringBuilder BuildCommandLine(string executable, string[] arguments)
    {
        StringBuilder commandLine = new StringBuilder(QuoteArgument(executable));
        foreach (string argument in arguments)
        {
            commandLine.Append(' ');
            commandLine.Append(QuoteArgument(argument));
        }
        return commandLine;
    }

    private static long CreationTicks(IntPtr process)
    {
        FILETIME creation;
        FILETIME exit;
        FILETIME kernel;
        FILETIME user;
        if (!GetProcessTimes(process, out creation, out exit, out kernel, out user))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        long fileTime = ((long)creation.dwHighDateTime << 32) | creation.dwLowDateTime;
        return DateTime.FromFileTimeUtc(fileTime).Ticks;
    }

    private static string ProcessImage(IntPtr process)
    {
        uint capacity = 32768;
        StringBuilder image = new StringBuilder((int)capacity);
        if (!QueryFullProcessImageName(process, 0, image, ref capacity))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        return image.ToString();
    }

    private static void ConfigureKillOnClose(IntPtr job)
    {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION information = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(information, buffer, false);
            if (!SetInformationJobObject(job, 9, buffer, (uint)size))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static uint ActiveProcesses(IntPtr job)
    {
        int size = Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            if (!QueryInformationJobObject(job, 1, buffer, (uint)size, IntPtr.Zero))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information =
                (JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)Marshal.PtrToStructure(
                    buffer, typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
            return information.ActiveProcesses;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static uint WaitForZero(IntPtr job, int milliseconds)
    {
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(Math.Max(0, milliseconds));
        uint active;
        do
        {
            active = ActiveProcesses(job);
            if (active == 0) return 0;
            Thread.Sleep(25);
        }
        while (DateTime.UtcNow < deadline);
        return ActiveProcesses(job);
    }

    private static void Respond(long requestId, string status, uint active, uint browserPid, long creationTicks)
    {
        lock (OutputLock)
        {
            Console.Out.WriteLine(
                "ATD_JOB_CONTROL " + Secret + " {\"requestId\":" + requestId.ToString() +
                ",\"status\":\"" + status + "\",\"active\":" + active.ToString() +
                ",\"browserPid\":" + browserPid.ToString() +
                ",\"creation\":\"" + creationTicks.ToString() + "\"}");
            Console.Out.Flush();
        }
    }

    private static void ReadCommands()
    {
        try
        {
            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                lock (Commands) Commands.Enqueue(line);
            }
        }
        finally
        {
            InputClosed = true;
        }
    }

    private static bool TryTakeCommand(out string command)
    {
        lock (Commands)
        {
            if (Commands.Count > 0)
            {
                command = Commands.Dequeue();
                return true;
            }
        }
        command = null;
        return false;
    }

    private static int Main(string[] arguments)
    {
        string failureProofFile = Environment.GetEnvironmentVariable("ATD_TEST_UNASSIGNED_FAILURE_PROOF");
        string abruptProofFile = Environment.GetEnvironmentVariable("ATD_TEST_ABRUPT_POST_CREATE_PROOF");
        IntPtr attributeList = IntPtr.Zero;
        IntPtr jobList = IntPtr.Zero;
        IntPtr job = IntPtr.Zero;
        IntPtr harness = IntPtr.Zero;
        IntPtr nullInput = new IntPtr(-1);
        PROCESS_INFORMATION child = new PROCESS_INFORMATION();
        bool childCreated = false;
        bool childAssigned = false;
        try
        {
            string executable = FullPath(RequiredEnvironment("ATD_REAL_EXECUTABLE"));
            string expectedProfile = FullPath(RequiredEnvironment("ATD_EXPECTED_PROFILE"));
            string profileSwitch = RequiredEnvironment("ATD_PROFILE_SWITCH");
            Secret = RequiredEnvironment("ATD_CONTROL_SECRET");
            uint harnessPid;
            if (!UInt32.TryParse(RequiredEnvironment("ATD_HARNESS_PROCESS_ID"), out harnessPid))
                Fail("invalid harness identity");
            if (!File.Exists(executable)) Fail("browser executable is unavailable");
            if (profileSwitch != "user-data-dir" && profileSwitch != "profile")
                Fail("invalid profile switch");
            ValidateProfileArgument(arguments, expectedProfile, profileSwitch);

            harness = OpenProcess(SYNCHRONIZE, false, harnessPid);
            if (harness == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            ConfigureKillOnClose(job);
            IntPtr attributeBytes = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeBytes);
            if (attributeBytes == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            attributeList = Marshal.AllocHGlobal(attributeBytes);
            if (!InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeBytes))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            jobList = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobList, job);
            if (!UpdateProcThreadAttribute(attributeList, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
                jobList, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error());

            SECURITY_ATTRIBUTES security = new SECURITY_ATTRIBUTES();
            security.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
            security.bInheritHandle = 1;
            nullInput = CreateFile("NUL", GENERIC_READ | GENERIC_WRITE, 3, ref security,
                OPEN_EXISTING, 0, IntPtr.Zero);
            if (nullInput == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
            IntPtr standardOutput = GetStdHandle(-11);
            IntPtr standardError = GetStdHandle(-12);
            if (!SetHandleInformation(standardOutput, HANDLE_FLAG_INHERIT, 0) ||
                !SetHandleInformation(standardError, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT))
                throw new Win32Exception(Marshal.GetLastWin32Error());

            STARTUPINFOEX startup = new STARTUPINFOEX();
            startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = nullInput;
            startup.StartupInfo.hStdOutput = standardError;
            startup.StartupInfo.hStdError = standardError;
            startup.lpAttributeList = attributeList;
            StringBuilder commandLine = BuildCommandLine(executable, arguments);
            if (!CreateProcessW(executable, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT, IntPtr.Zero,
                Environment.CurrentDirectory, ref startup, out child))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            childCreated = true;

            if (!String.IsNullOrEmpty(abruptProofFile))
            {
                File.WriteAllText(abruptProofFile, child.dwProcessId.ToString());
                if (!NativeTerminateProcess(GetCurrentProcess(), 97))
                {
                    File.WriteAllText(abruptProofFile, "self-terminate-failed");
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
                Thread.Sleep(Timeout.Infinite);
            }

            bool inExactJob;
            if (!IsProcessInJob(child.hProcess, job, out inExactJob) || !inExactJob)
                Fail("created browser handle was not atomically assigned to its Job");

            string actualImage = ProcessImage(child.hProcess);
            long creationTicks = CreationTicks(child.hProcess);
            if (!SamePath(actualImage, executable) || creationTicks <= 0)
                Fail("created browser handle failed identity verification");
            if (!String.IsNullOrEmpty(failureProofFile))
                Fail("injected pre-assignment failure");
            childAssigned = true;
            if (ResumeThread(child.hThread) == UInt32.MaxValue)
                throw new Win32Exception(Marshal.GetLastWin32Error());
            CloseHandle(child.hThread);
            child.hThread = IntPtr.Zero;

            Thread reader = new Thread(ReadCommands);
            reader.IsBackground = true;
            reader.Start();
            Respond(0, "bound", ActiveProcesses(job), child.dwProcessId, creationTicks);

            bool done = false;
            while (!done)
            {
                if (WaitForSingleObject(harness, 0) == WAIT_OBJECT_0 || InputClosed)
                {
                    TerminateJobObject(job, 1);
                    WaitForZero(job, 30000);
                    break;
                }
                string command;
                while (TryTakeCommand(out command))
                {
                    string[] fields = command.Split('\t');
                    long requestId;
                    int timeout;
                    if (fields.Length != 4 || fields[0] != Secret ||
                        !Int64.TryParse(fields[1], out requestId) || !Int32.TryParse(fields[3], out timeout))
                        continue;
                    timeout = Math.Max(0, Math.Min(30000, timeout));
                    if (fields[2] == "query")
                    {
                        Respond(requestId, "inspected", ActiveProcesses(job), child.dwProcessId, creationTicks);
                    }
                    else if (fields[2] == "terminate")
                    {
                        uint active = ActiveProcesses(job);
                        if (active > 0 && !TerminateJobObject(job, 1))
                            throw new Win32Exception(Marshal.GetLastWin32Error());
                        active = WaitForZero(job, timeout);
                        Respond(requestId, active == 0 ? "terminated" : "termination-pending",
                            active, child.dwProcessId, creationTicks);
                    }
                    else if (fields[2] == "release")
                    {
                        uint active = ActiveProcesses(job);
                        Respond(requestId, active == 0 ? "released" : "release-refused",
                            active, child.dwProcessId, creationTicks);
                        if (active == 0) done = true;
                    }
                }
                Thread.Sleep(25);
            }
            return 0;
        }
        catch (Exception)
        {
            try
            {
                lock (OutputLock)
                {
                    Console.Error.WriteLine("ATD Windows Job controller failed: controller-error");
                    Console.Error.Flush();
                }
            }
            catch {}
            return 1;
        }
        finally
        {
            if (childCreated && !childAssigned && child.hProcess != IntPtr.Zero)
            {
                bool terminated = false;
                try
                {
                    TerminateProcessByHandle(child.hProcess);
                    terminated = true;
                }
                catch {}
                if (!String.IsNullOrEmpty(failureProofFile))
                {
                    try { File.WriteAllText(failureProofFile, terminated ? "terminated" : "unverified"); }
                    catch {}
                }
            }
            if (job != IntPtr.Zero)
            {
                try
                {
                    if (ActiveProcesses(job) > 0) TerminateJobObject(job, 1);
                    WaitForZero(job, 30000);
                }
                catch {}
            }
            if (child.hThread != IntPtr.Zero) CloseHandle(child.hThread);
            if (child.hProcess != IntPtr.Zero) CloseHandle(child.hProcess);
            if (nullInput != new IntPtr(-1)) CloseHandle(nullInput);
            if (attributeList != IntPtr.Zero) DeleteProcThreadAttributeList(attributeList);
            if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
            if (attributeList != IntPtr.Zero) Marshal.FreeHGlobal(attributeList);
            if (job != IntPtr.Zero) CloseHandle(job);
            if (harness != IntPtr.Zero) CloseHandle(harness);
        }
    }

    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "TerminateProcess")]
    private static extern bool NativeTerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    private static void TerminateProcessByHandle(IntPtr process)
    {
        if (!NativeTerminateProcess(process, 1)) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (WaitForSingleObject(process, 30000) != WAIT_OBJECT_0)
            throw new InvalidOperationException("pinned process did not terminate");
        uint exitCode;
        if (!GetExitCodeProcess(process, out exitCode) || exitCode == STILL_ACTIVE)
            throw new InvalidOperationException("pinned process exit was not verified");
    }
}
