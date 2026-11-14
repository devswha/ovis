//! The terminal screen: hc-tui, started on the agent the inbox had selected, until the user
//! leaves it with hc-tui's own detach key.
use hc_tui::embed::Embed;
use ovis_tui_client::net::{Net, Reply};
use ovis_tui_client::ui::{Effect, Event, State};
use tokio::sync::mpsc::UnboundedReceiver;

use crate::run::Setting;

/// What stays at work while the terminal screen is up.
pub struct Away<'a> {
    pub state: &'a mut State,
    pub replies: &'a mut UnboundedReceiver<Reply>,
    pub net: &'a Net,
}

/// Runs hc-tui's screen to its end. The server's answers go on changing the inbox's state
/// meanwhile, so the inbox is current the moment it is back. Input typed while a terminal's
/// connection recovers is refused there, never sent later, and a phone-width screen shows the
/// one terminal that was opened, not its tab's whole split.
pub async fn open(
    setting: &Setting,
    pane: Option<String>,
    away: &mut Away<'_>,
) -> Result<(), String> {
    let embed = Embed {
        focus: pane,
        discard_input_on_recovery: true,
        solo_on_narrow: true,
        no_core_start: true,
    };
    let screen = hc_tui::cli::run_embedded(&setting.endpoint, &setting.env, embed);
    tokio::pin!(screen);
    loop {
        tokio::select! {
            ended = &mut screen => return ended,
            Some(reply) = away.replies.recv() => {
                for effect in away.state.on(Event::Net(reply)) {
                    match effect {
                        Effect::Ask(job) => away.net.ask(job),
                        Effect::Watch(pane) => away.net.watch(pane.as_deref()),
                        // the terminal screen is up: nothing else acts until it is left
                        Effect::OpenTerminal(_) | Effect::Remember { .. } | Effect::Quit => {}
                    }
                }
            }
        }
    }
}
