mod args;
mod dump;
mod keymap;
mod run;
mod screen;
mod terminal;
mod theme;

use std::process::ExitCode;

fn main() -> ExitCode {
    match args::parse(std::env::args().skip(1)) {
        Ok(args::Action::Help) => {
            println!("{}", args::help());
            ExitCode::SUCCESS
        }
        Ok(args::Action::Version) => {
            println!("{}", args::version());
            ExitCode::SUCCESS
        }
        Ok(args::Action::Run(options)) => match start(&options) {
            Ok(()) => ExitCode::SUCCESS,
            Err(message) => {
                eprintln!("ovis-tui: {message}");
                ExitCode::FAILURE
            }
        },
        Err(message) => {
            eprintln!("ovis-tui: {message}");
            eprintln!("Try 'ovis-tui --help'.");
            ExitCode::from(2)
        }
    }
}

fn start(options: &args::Options) -> Result<(), String> {
    let setting = run::Setting::read(options)?;
    if let Some(size) = options.dump {
        return dump::once(&setting, size);
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("runtime: {error}"))?;
    runtime.block_on(run::run(&setting))
}
