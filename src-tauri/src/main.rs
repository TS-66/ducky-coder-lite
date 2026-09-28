// A console binary would be attached to a parent console on Windows and would
// flash a black window on every launch, so this is a windows-subsystem binary.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ducky_lite_lib::run();
}
