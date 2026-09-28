//! System + process memory accounting.
//!
//! This module is the backbone of the 2 GB RAM strategy. It answers two
//! questions, cheaply and without polling the whole system:
//!
//! 1. How much memory is this process using? (so the status bar can be honest)
//! 2. How much memory is the machine short on? (so we can shed load early)
//!
//! Every read is a direct `/proc` or syscall read. No dependency walks, no
//! `sysinfo` crate buffering every process on the system into a `HashMap` —
//! that is exactly the kind of "helpful" background work a 2 GB machine cannot
//! afford.

use serde::Serialize;

/// Snapshot of system and process memory, in mebibytes.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemSnapshot {
    /// Resident set size of the editor process itself.
    pub process_rss_mb: f64,
    /// Resident memory attributable to the WebKit content/UI processes that
    /// Tauri spawns for the webview. Counting only our own RSS would badly
    /// understate real cost on a small machine.
    pub webview_rss_mb: f64,
    /// Combined footprint: the number the status bar shows.
    pub app_total_mb: f64,
    /// Memory the whole machine is using right now.
    pub system_used_mb: f64,
    /// Memory the whole machine has installed.
    pub system_total_mb: f64,
    /// Memory still available to new allocations without swapping.
    pub system_available_mb: f64,
    /// Swap in use, if any. Zero on machines without swap.
    pub swap_used_mb: f64,
    /// `system_available / system_total`, 0.0–1.0.
    pub available_ratio: f64,
    /// Countdown of our own threads; a rough but honest CPU-usage proxy.
    pub thread_count: u32,
}

/// Read the current system memory state.
///
/// This is designed to be called on a timer (default: 2 s) from one dedicated
/// task and nowhere else.
pub fn snapshot() -> MemSnapshot {
    let mut snap = MemSnapshot::default();

    #[cfg(target_os = "linux")]
    {
        read_proc_meminfo(&mut snap);
    }

    #[cfg(target_os = "macos")]
    {
        read_macos_mem(&mut snap);
    }

    #[cfg(target_os = "windows")]
    {
        read_windows_mem(&mut snap);
    }

    read_process_rss(&mut snap);
    snap.thread_count = thread_count();
    snap
}

#[cfg(target_os = "linux")]
fn read_proc_meminfo(snap: &mut MemSnapshot) {
    let Ok(text) = std::fs::read_to_string("/proc/meminfo") else {
        return;
    };
    // /proc/meminfo is line oriented, so one pass with a match on the key is
    // both the fastest and the clearest way to read it.
    let (mut mem_total, mut mem_available) = (0.0f64, 0.0f64);
    let (mut swap_total, mut swap_free) = (0.0f64, 0.0f64);
    for line in text.lines() {
        let mut it = line.split_whitespace();
        let Some(key) = it.next() else { continue };
        let Some(kb) = it.next().and_then(|v| v.parse::<f64>().ok()) else {
            continue;
        };
        // Every value in /proc/meminfo is reported in KiB.
        let mb = kb / 1024.0;
        match key {
            "MemTotal:" => mem_total = mb,
            "MemAvailable:" => mem_available = mb,
            "SwapTotal:" => swap_total = mb,
            "SwapFree:" => swap_free = mb,
            _ => {}
        }
    }

    snap.system_total_mb = mem_total;
    snap.system_available_mb = mem_available;
    // Derive "used" from MemAvailable rather than MemFree: on a modern kernel
    // the page cache is reclaimable, so counting it as "used" would make us
    // think a machine with a warm cache is out of memory.
    snap.system_used_mb = (mem_total - mem_available).max(0.0);
    snap.swap_used_mb = (swap_total - swap_free).max(0.0);
}

#[cfg(target_os = "macos")]
fn read_macos_mem(snap: &mut MemSnapshot) {
    // macOS exposes the same numbers Activity Monitor shows, via the same two
    // sysctls. We declare the FFI surface locally rather than pulling in a
    // process-listing crate just to read two scalars.
    const MIB_LEN: usize = 2;
    const CTL_HW: i32 = 1;
    const HW_MEMSIZE: i32 = 24;
    const HW_PAGECOUNT: i32 = 19;

    extern "C" {
        fn sysctl(mib: *mut i32, miblen: u32, oldp: *mut std::ffi::c_void, oldlenp: *mut usize)
            -> i32;
    }

    let read_u64 = |mib: &mut [i32; MIB_LEN]| -> u64 {
        let mut value: u64 = 0;
        let mut len = std::mem::size_of::<u64>();
        // SAFETY: `mib` is a correctly formed 2-element CTL_HW query, and
        // `oldp` points at a live u64 with its size supplied via `oldlenp`.
        let rc = unsafe {
            sysctl(
                mib.as_mut_ptr(),
                MIB_LEN as u32,
                &mut value as *mut u64 as *mut std::ffi::c_void,
                &mut len,
            )
        };
        if rc == 0 && len == std::mem::size_of::<u64>() {
            value
        } else {
            0
        }
    };

    let total_bytes = read_u64(&mut [CTL_HW, HW_MEMSIZE]);
    let page_count = read_u64(&mut [CTL_HW, HW_PAGECOUNT]);
    let page_size = if total_bytes > 0 && page_count > 0 {
        (total_bytes / page_count) as f64
    } else {
        4096.0
    };

    const MB: f64 = 1024.0 * 1024.0;
    if total_bytes > 0 {
        snap.system_total_mb = total_bytes as f64 / MB;
    }

    // `vm_statistics64` is the only way to get a macOS equivalent of
    // MemAvailable; Activity Monitor's "Memory Used" is
    // (active + wired + compressed) pages.
    #[repr(C)]
    #[derive(Default)]
    struct VmStat64 {
        free_count: u64,
        active_count: u64,
        inactive_count: u64,
        wire_count: u64,
        compressor_page_count: u64,
    }
    extern "C" {
        fn host_statistics64(
            host: u32,
            flavor: i32,
            host_info: *mut std::ffi::c_void,
            host_info_size: *mut usize,
        ) -> i32;
    }

    let mut vm = VmStat64::default();
    let mut size = std::mem::size_of::<VmStat64>();
    // SAFETY: HOST_VM_INFO64 = 4, HOST_LOCALHOST = 1, and `vm` is a live
    // struct whose size we pass in.
    let rc = unsafe {
        host_statistics64(
            1,
            4,
            &mut vm as *mut VmStat64 as *mut std::ffi::c_void,
            &mut size,
        )
    };

    if rc == 0 && page_size > 0.0 {
        let pages = |n: u64| n as f64 * page_size / MB;
        let used = pages(vm.active_count)
            + pages(vm.wire_count)
            + pages(vm.compressor_page_count);
        // Inactive pages are reclaimable file cache, so they count as free.
        let available = pages(vm.free_count) + pages(vm.inactive_count);
        snap.system_used_mb = used;
        snap.system_available_mb = available;
    } else {
        // Without vm_statistics64 we cannot claim to know; report a
        // conservative half-free so we do not spuriously shed load.
        snap.system_available_mb = snap.system_total_mb * 0.5;
        snap.system_used_mb = snap.system_total_mb - snap.system_available_mb;
    }
}

#[cfg(target_os = "windows")]
fn read_windows_mem(snap: &mut MemSnapshot) {
    // GlobalMemoryStatusEx via the Win32 API. Declared locally to keep the
    // dependency surface of the whole app small.
    use std::ffi::c_void;
    #[repr(C)]
    #[allow(non_snake_case)]
    struct MEMORYSTATUSEX {
        dwLength: u32,
        dwMemoryLoad: u32,
        ullTotalPhys: u64,
        ullAvailPhys: u64,
        ullTotalPageFile: u64,
        ullAvailPageFile: u64,
        ullTotalVirtual: u64,
        ullAvailVirtual: u64,
        ullAvailExtendedVirtual: u64,
    }
    extern "system" {
        fn GlobalMemoryStatusEx(lpBuffer: *mut c_void) -> i32;
    }
    let mut st = MEMORYSTATUSEX {
        dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
        dwMemoryLoad: 0,
        ullTotalPhys: 0,
        ullAvailPhys: 0,
        ullTotalPageFile: 0,
        ullAvailPageFile: 0,
        ullTotalVirtual: 0,
        ullAvailVirtual: 0,
        ullAvailExtendedVirtual: 0,
    };
    // SAFETY: pointer to a correctly sized, correctly initialised struct.
    unsafe {
        if GlobalMemoryStatusEx(&mut st as *mut _ as *mut c_void) != 0 {
            const MB: f64 = 1024.0 * 1024.0;
            snap.system_total_mb = st.ullTotalPhys as f64 / MB;
            snap.system_available_mb = st.ullAvailPhys as f64 / MB;
            snap.system_used_mb =
                (st.ullTotalPhys.saturating_sub(st.ullAvailPhys)) as f64 / MB;
            snap.swap_used_mb = st.ullTotalPageFile.saturating_sub(st.ullAvailPageFile) as f64 / MB;
        }
    }
}

fn thread_count() -> u32 {
    #[cfg(target_os = "linux")]
    {
        if let Ok(dir) = std::fs::read_dir("/proc/self/task") {
            return dir.count() as u32;
        }
    }
    0
}

/// Fill in this process's RSS, plus the RSS of any WebKit helper processes we
/// spawned (WebKitWebProcess, WebKitNetworkProcess, ...).
///
/// On Linux the children are found via `/proc/<pid>/stat`'s ppid field, so we
/// avoid the `sysinfo` crate's habit of building a table of every process on
/// the box.
fn read_process_rss(snap: &mut MemSnapshot) {
    #[cfg(target_os = "linux")]
    {
        let self_pid = std::process::id();

        if let Ok(status) = std::fs::read_to_string("/proc/self/status") {
            for line in status.lines() {
                if let Some(rest) = line.strip_prefix("VmRSS:") {
                    if let Some(kb) = rest.split_whitespace().next().and_then(|v| v.parse::<f64>().ok()) {
                        snap.process_rss_mb = kb / 1024.0;
                    }
                }
            }
        }

        // Walk /proc for our descendants. This is a few hundred small reads at
        // most, executed on a 2-second timer, and it is the only way to be
        // honest about what the webview costs us.
        let mut children: Vec<u32> = Vec::new();
        if let Ok(entries) = std::fs::read_dir("/proc") {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let Some(name) = name.to_str() else { continue };
                if !name.chars().all(|c| c.is_ascii_digit()) {
                    continue;
                }
                let Ok(pid) = name.parse::<u32>() else { continue };
                if pid == self_pid {
                    continue;
                }
                if let Some(ppid) = read_ppid(pid) {
                    if ppid == self_pid {
                        children.push(pid);
                    }
                }
            }
        }

        let mut webview = 0.0f64;
        for pid in children {
            if let Some(rss) = read_rss_kb(pid) {
                let comm = read_comm(pid);
                if comm.contains("WebKit") || comm.contains("webkit") {
                    webview += rss / 1024.0;
                }
            }
        }
        snap.webview_rss_mb = webview;
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        // The webview on macOS and Windows runs in-process with the host, so
        // there is no separate PID to attribute to.
        snap.process_rss_mb = read_self_rss_mb();
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        // A target we have no RSS API for. Report nothing rather than guessing:
        // a wrong number in the status bar is worse than an absent one.
        snap.process_rss_mb = 0.0;
    }

    snap.app_total_mb = snap.process_rss_mb + snap.webview_rss_mb;

    if snap.system_total_mb > 0.0 {
        snap.available_ratio = (snap.system_available_mb / snap.system_total_mb).clamp(0.0, 1.0);
    }
}

/// Resident set size of the current process, in MB.
#[cfg(target_os = "macos")]
fn read_self_rss_mb() -> f64 {
    use std::ffi::c_void;
    extern "C" {
        fn mach_task_self() -> u32;
        fn task_info(
            task: u32,
            flavor: i32,
            task_info: *mut c_void,
            task_info_count: *mut usize,
        ) -> i32;
    }
    const TASK_BASIC_INFO: i32 = 20;
    const MACH_TASK_BASIC_INFO: i32 = 20;

    #[repr(C)]
    #[derive(Default)]
    struct TaskBasicInfo {
        suspend_count: i32,
        virtual_size: u64,
        resident_size: u64,
        user_time: [u32; 2],
        system_time: [u32; 2],
        policy: i32,
    }

    let mut info = TaskBasicInfo::default();
    let mut count = std::mem::size_of::<TaskBasicInfo>();
    // SAFETY: `mach_task_self()` is valid for the lifetime of the process, and
    // `info` is a live, correctly sized MACH_TASK_BASIC_INFO buffer.
    let rc = unsafe {
        task_info(
            mach_task_self(),
            MACH_TASK_BASIC_INFO,
            &mut info as *mut TaskBasicInfo as *mut c_void,
            &mut count,
        )
    };
    let _ = TASK_BASIC_INFO;
    if rc == 0 {
        info.resident_size as f64 / (1024.0 * 1024.0)
    } else {
        0.0
    }
}

/// Resident set size of the current process, in MB.
#[cfg(target_os = "windows")]
fn read_self_rss_mb() -> f64 {
    use std::ffi::c_void;
    #[repr(C)]
    struct ProcessMemoryCounters {
        cb: u32,
        page_fault_count: u32,
        peak_working_set_size: usize,
        working_set_size: usize,
        quota_peak_paged_pool_usage: usize,
        quota_paged_pool_usage: usize,
        quota_peak_non_paged_pool_usage: usize,
        quota_non_paged_pool_usage: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
    }
    #[link(name = "psapi")]
    extern "system" {
        fn GetProcessMemoryInfo(
            process: *mut c_void,
            ppsmemCounters: *mut ProcessMemoryCounters,
            cb: u32,
        ) -> i32;
        fn GetCurrentProcess() -> *mut c_void;
    }
    let mut ctr = ProcessMemoryCounters {
        cb: std::mem::size_of::<ProcessMemoryCounters>() as u32,
        page_fault_count: 0,
        peak_working_set_size: 0,
        working_set_size: 0,
        quota_peak_paged_pool_usage: 0,
        quota_paged_pool_usage: 0,
        quota_peak_non_paged_pool_usage: 0,
        quota_non_paged_pool_usage: 0,
        pagefile_usage: 0,
        peak_pagefile_usage: 0,
    };
    // SAFETY: the pseudo-handle from GetCurrentProcess is always valid, and
    // `ctr` is a live struct with `cb` set to its size as the API requires.
    let ok = unsafe {
        GetProcessMemoryInfo(
            GetCurrentProcess(),
            &mut ctr,
            std::mem::size_of::<ProcessMemoryCounters>() as u32,
        )
    } != 0;
    if ok {
        ctr.working_set_size as f64 / (1024.0 * 1024.0)
    } else {
        0.0
    }
}

#[cfg(target_os = "linux")]
fn read_ppid(pid: u32) -> Option<u32> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // The comm field is parenthesised and may itself contain spaces and
    // parentheses, so scan from the last ')' before splitting.
    let after = &stat[stat.rfind(')')? + 1..];
    after.split_whitespace().nth(1)?.parse().ok()
}

#[cfg(target_os = "linux")]
fn read_rss_kb(pid: u32) -> Option<f64> {
    let status = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix("VmRSS:") {
            return rest.split_whitespace().next()?.parse().ok();
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn read_comm(pid: u32) -> String {
    std::fs::read_to_string(format!("/proc/{pid}/comm")).unwrap_or_default()
}

/// Best-effort free memory hint used to decide whether to shed load *before*
/// taking a full snapshot (called on hot paths such as opening a new tab).
#[cfg(target_os = "linux")]
pub fn quick_available_mb() -> f64 {
    let Ok(text) = std::fs::read_to_string("/proc/meminfo") else {
        return 1024.0;
    };
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("MemAvailable:") {
            if let Some(kb) = rest.split_whitespace().next().and_then(|v| v.parse::<f64>().ok()) {
                return kb / 1024.0;
            }
        }
    }
    1024.0
}

#[cfg(not(target_os = "linux"))]
pub fn quick_available_mb() -> f64 {
    snapshot().system_available_mb
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_is_sane() {
        let s = snapshot();
        // On any real machine we must report a positive footprint.
        assert!(s.process_rss_mb > 0.0, "rss should be positive: {s:?}");
        assert!(s.available_ratio <= 1.0);
        assert!(s.available_ratio >= 0.0);
    }

    #[test]
    fn repeated_snapshots_do_not_leak_obviously() {
        let before = snapshot().process_rss_mb;
        for _ in 0..200 {
            let _ = snapshot();
        }
        let after = snapshot().process_rss_mb;
        // Our own accounting allocates a few hundred KB transiently; anything
        // beyond that would indicate a real leak.
        assert!(
            after - before < 32.0,
            "snapshot appears to leak: {before} -> {after}"
        );
    }
}
