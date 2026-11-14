//! The command line. Help and version answer before anything connects.

#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    Help,
    Version,
    Run(Options),
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Options {
    /// The herdr-core session: `--session`, else `HC_SESSION`, else `default`.
    pub session: Option<String>,
    /// The Ovis server's origin: `--url`, else `OVIS_URL`, else `HOST` and `PORT`.
    pub url: Option<String>,
    /// Print one frame of this size and leave: `--dump-once COLSxROWS`.
    pub dump: Option<(u16, u16)>,
}

pub fn parse(args: impl IntoIterator<Item = String>) -> Result<Action, String> {
    let mut options = Options::default();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let (name, inline) = match arg.split_once('=') {
            Some((name, value)) if name.starts_with("--") => {
                (name.to_owned(), Some(value.to_owned()))
            }
            _ => (arg, None),
        };
        match name.as_str() {
            "-h" | "--help" => return Ok(Action::Help),
            "-V" | "--version" => return Ok(Action::Version),
            "--session" => options.session = Some(value(&name, inline, &mut args)?),
            "--url" => options.url = Some(value(&name, inline, &mut args)?),
            "--dump-once" => options.dump = Some(size(&value(&name, inline, &mut args)?)?),
            other => return Err(format!("unexpected argument '{other}'")),
        }
    }
    Ok(Action::Run(options))
}

fn value(
    name: &str,
    inline: Option<String>,
    rest: &mut impl Iterator<Item = String>,
) -> Result<String, String> {
    inline
        .or_else(|| rest.next())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{name} needs a value"))
}

fn size(text: &str) -> Result<(u16, u16), String> {
    let parsed = text
        .split_once('x')
        .and_then(|(cols, rows)| Some((cols.parse::<u16>().ok()?, rows.parse::<u16>().ok()?)));
    match parsed {
        Some((cols, rows)) if cols >= 20 && rows >= 5 => Ok((cols, rows)),
        _ => Err(format!(
            "--dump-once takes COLSxROWS, at least 20x5 (got '{text}')"
        )),
    }
}

pub fn version() -> String {
    format!("ovis-tui {}", env!("CARGO_PKG_VERSION"))
}

pub fn help() -> String {
    format!(
        "\
{}
The Ovis inbox in a terminal, for herdr-core: the agents that wait for you, their question
cards, and their terminals (hc-tui's sidebar, tabs and splits).

Usage: ovis-tui [OPTIONS]

Options:
      --session <NAME>        herdr-core session (default: $HC_SESSION or \"default\")
      --url <ORIGIN>          this PC's Ovis server (default: $OVIS_URL, or $HOST and $PORT,
                              or http://127.0.0.1:7317)
      --dump-once <COLSxROWS> print one frame of that size and leave
  -h, --help                  print this help
  -V, --version               print the version

Inbox keys: j/k or arrows move, enter opens, 1-9 answer the card, t terminal, m mark read,
r refresh, b back, ? help, q quit. In a terminal, herdr's detach key (Ctrl+B q unless your
herdr config binds another) comes back to the inbox.

The terminal screen is hc-tui (https://github.com/followcat/hc-tui, Apache-2.0) with a few
small changes of ours. Not affiliated with or endorsed by hc-tui or the Herdr project.",
        version()
    )
}
