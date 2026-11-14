//! One frame as text, then leave: for a look without a terminal, and for checks.
use ovis_tui_client::api::Client;
use ovis_tui_client::ui::{self, Scene, Setup, State};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;

use crate::run::Setting;
use crate::theme;

pub fn once(setting: &Setting, size: (u16, u16)) -> Result<(), String> {
    let theme = theme::load();
    let client = Client::new(setting.server.clone());
    let mut state = State::new(Setup {
        origin: setting.server.origin.clone(),
        narrow_at: theme.narrow_at,
        size,
        resume: None,
    });
    let first = state.start();
    ui::settle(&mut state, &client, first);
    let area = Rect::new(0, 0, size.0, size.1);
    let mut frame = Buffer::empty(area);
    let scene = Scene {
        state: &state,
        colors: &theme.colors,
        terminal_key: &theme.terminal_key,
    };
    ui::draw(&mut frame, area, &scene);
    for row in ui::rows_of(&frame) {
        println!("{row}");
    }
    Ok(())
}
