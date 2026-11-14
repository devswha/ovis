//! One run of the client: the inbox's loop, and the terminal screen it hands over to.
use std::collections::{BTreeMap, VecDeque};
use std::ffi::{OsStr, OsString};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use hc_proto::endpoint::{self, Endpoint, Env, Sys};
use ovis_tui_client::api::Server;
use ovis_tui_client::net::{Job, Net, Reply};
use ovis_tui_client::resume::{self, Keeper, Place};
use ovis_tui_client::ui::{Effect, Event, Looker, Scene, Setup, State};
use std::os::unix::net::UnixStream;

use crate::args::Options;
use crate::screen::{self, Screen};
use crate::terminal::{self, Away};
use crate::theme;

/// What a run is given: which herdr-core, which Ovis server, and where its place is kept.
pub struct Setting {
    pub endpoint: Endpoint,
    /// The environment hc-tui's screen reads.
    pub env: Env,
    /// The core's socket, as text.
    pub core: String,
    pub server: Server,
    pub place_file: Option<PathBuf>,
}

impl Setting {
    pub fn read(options: &Options, mut vars: BTreeMap<String, String>) -> Result<Setting, String> {
        let mut env = endpoint::env_snapshot();
        // hc-tui's own release check would send this client's users to "hc-tui --upgrade"
        env.insert(
            OsString::from("HC_TUI_NO_UPDATE_CHECK"),
            OsString::from("1"),
        );
        let session = options.session.as_deref().map(OsStr::new);
        let endpoint = endpoint::resolve(&env, session, None, &Sys)
            .map_err(|error| format!("herdr-core endpoint: {error}"))?;
        let core = match &endpoint {
            Endpoint::Local(local) => local.socket.display().to_string(),
            Endpoint::Remote(remote) => format!("{}:{}", remote.target, remote.session),
        };
        if let Some(url) = &options.url {
            vars.insert("OVIS_URL".to_owned(), url.clone());
        }
        Ok(Setting {
            endpoint,
            env,
            core,
            server: Server::from_env(&vars),
            place_file: resume::path(|name| std::env::var_os(name)),
        })
    }
}

/// The file the user's place is kept in. One that cannot be written is told once and left
/// alone for the rest of the run.
struct PlaceFile(Option<PathBuf>);

impl PlaceFile {
    fn write(&mut self, place: Option<Place>) -> Option<String> {
        let place = place?;
        let file = self.0.as_ref()?;
        let error = resume::save(file, &place).err()?;
        let told = format!(
            "Your place is not kept for the next run ({}: {error}).",
            file.display()
        );
        self.0 = None;
        Some(told)
    }
}

/// What to tell the user when the local core does not answer. This program never starts one: a core
/// it started would inherit its environment, and Ovis never starts an engine on its own.
fn core_down(endpoint: &Endpoint) -> Option<String> {
    let Endpoint::Local(local) = endpoint else {
        return None;
    };
    if UnixStream::connect(&local.socket).is_ok() {
        return None;
    }
    let start = if local.session == "default" {
        "hc server start".to_owned()
    } else {
        format!("HC_SESSION={} hc server start", local.session)
    };
    Some(format!("herdr-core is not running. Start it with: {start}"))
}

async fn until(due: Option<Instant>) {
    match due {
        Some(due) => tokio::time::sleep_until(tokio::time::Instant::from_std(due)).await,
        None => std::future::pending().await,
    }
}

pub async fn run(setting: &Setting) -> Result<(), String> {
    let theme = theme::load();
    let (answers, mut replies) = tokio::sync::mpsc::unbounded_channel::<Reply>();
    // the receiver is gone only when this function is: nothing waits for the answer then
    let net = Net::start(
        &setting.server,
        Arc::new(move |reply| drop(answers.send(reply))),
    );
    let mut screen = Screen::enter(theme.mouse)?;
    let kept = setting
        .place_file
        .as_deref()
        .and_then(|file| resume::load(file, &setting.core));
    let mut state = State::new(Setup {
        origin: setting.server.origin.clone(),
        narrow_at: theme.narrow_at,
        size: screen.size()?,
        resume: kept.clone(),
    });
    let mut keeper = Keeper::new(setting.core.clone(), kept);
    let mut place_file = PlaceFile(setting.place_file.clone());
    let mut looker = Looker::default();
    let mut todo: VecDeque<Effect> = state.start().into();
    'run: loop {
        while let Some(effect) = todo.pop_front() {
            match effect {
                Effect::Ask(job) => net.ask(job),
                Effect::Watch(pane) => net.watch(pane.as_deref()),
                Effect::Remember { spot, pane } => keeper.note(spot, pane, Instant::now()),
                Effect::Quit => break 'run,
                Effect::OpenTerminal(pane) => {
                    if let Some(down) = core_down(&setting.endpoint) {
                        state.notice = Some(down);
                        continue;
                    }
                    let unkept = place_file.write(keeper.take(None));
                    looker.away();
                    drop(screen);
                    let mut away = Away {
                        state: &mut state,
                        replies: &mut replies,
                        net: &net,
                    };
                    let ended = terminal::open(setting, pane, &mut away).await;
                    screen = Screen::enter(theme.mouse)?;
                    let (cols, rows) = screen.size()?;
                    todo.extend(state.on(Event::Resize { cols, rows }));
                    todo.extend(state.on(Event::TerminalClosed(ended.err().or(unkept))));
                }
            }
        }
        let hits = screen.draw(&Scene {
            state: &state,
            colors: &theme.colors,
            terminal_key: &theme.terminal_key,
        })?;
        state.drawn(&hits);
        looker.see(&state.front(), Instant::now());
        let due = [looker.due(), keeper.due()].into_iter().flatten().min();
        let event = tokio::select! {
            input = screen.next() => match input {
                Some(input) => screen::event(input, &hits),
                None => break 'run,
            },
            reply = replies.recv() => match reply {
                Some(reply) => Some(Event::Net(reply)),
                None => break 'run,
            },
            () = until(due) => {
                let now = Instant::now();
                if let Some((finish, presented)) = looker.rested(now) {
                    net.ask(Job::MarkSeen(finish, presented));
                }
                if let Some(told) = place_file.write(keeper.take(Some(now))) {
                    state.notice = Some(told);
                }
                None
            }
        };
        if let Some(event) = event {
            todo.extend(state.on(event));
        }
    }
    let unkept = place_file.write(keeper.take(None));
    drop(screen);
    net.stop();
    if let Some(told) = unkept {
        eprintln!("ovis-tui: {told}");
    }
    Ok(())
}
