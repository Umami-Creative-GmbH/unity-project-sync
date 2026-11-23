//! Powers off the machine (used by the "Shutdown after" option).

use std::process::Command;

fn shutdown_command() -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut c = Command::new("shutdown");
        c.args(["/s", "/t", "0"]).creation_flags(CREATE_NO_WINDOW);
        c
    }
    #[cfg(target_os = "macos")]
    {
        let mut c = Command::new("osascript");
        c.args(["-e", "tell app \"System Events\" to shut down"]);
        c
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let mut c = Command::new("systemctl");
        c.arg("poweroff");
        c
    }
}

pub fn shutdown_system() -> Result<(), String> {
    let output = shutdown_command()
        .output()
        .map_err(|e| format!("Could not start the shutdown command: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = if stderr.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            stderr.trim().to_string()
        };
        Err(format!("Shutdown failed ({}): {detail}", output.status))
    }
}
