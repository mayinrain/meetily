#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use log;
use env_logger;

fn main() {
    std::env::set_var("RUST_LOG", "info");
    let mut logger = env_logger::Builder::from_default_env();
    let mut arguments = std::env::args_os().skip(1);
    while let Some(argument) = arguments.next() {
        if argument == "--log-file" {
            let path = arguments.next().expect("--log-file requires a path");
            let file = std::fs::OpenOptions::new().write(true).create_new(true)
                .open(path).expect("Cannot create a new application log file");
            logger.target(env_logger::Target::Pipe(Box::new(file)));
        }
    }
    logger.init();
    std::panic::set_hook(Box::new(|panic| log::error!("Application panic: {panic}")));

    // Async logger will be initialized lazily when first needed (after Tauri runtime starts)
    log::info!("Starting application...");
    app_lib::run();
    log::info!("Application exited");
}
