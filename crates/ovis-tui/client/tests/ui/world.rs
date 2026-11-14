//! A session to draw and press keys in: four agents, one in each state, the first with a
//! question card and a chat.
use ovis_tui_client::api::{Client, Server};
use ovis_tui_client::live::LiveEvent;
use ovis_tui_client::net::Reply;
use ovis_tui_client::resume::Place;
use ovis_tui_client::ui::{self, Colors, Effect, Event, Hits, Intent, Scene, Setup, State};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use serde_json::{Value, json};

use crate::site::{Answers, Site};

pub const ASKS: &str = "add a TUI package skeleton";
pub const WORKS: &str = "run the fleet trial";
pub const DONE: &str = "document the retry policy";
pub const RESTS: &str = "scratch";
pub const QUESTION: &str = "Which test runner should I use?";
pub const NARROW_AT: u16 = 64;

pub fn pane(id: &str, status: &str, more: Value) -> Value {
    let mut pane = json!({ "pane_id": id, "terminal_id": id, "workspace_id": "w1", "tab_id": "w1:t1",
        "agent": "claude", "agent_status": status, "focused": false, "revision": 0 });
    if let (Some(fields), Some(more)) = (pane.as_object_mut(), more.as_object()) {
        fields.extend(more.clone());
    }
    pane
}

pub fn session(panes: &[Value]) -> Value {
    json!({ "snapshot": { "protocol": 22, "version": "0.1.18", "finish_epoch": "e1", "agents": [], "layouts": [],
        "workspaces": [{ "workspace_id": "w1", "label": "ovis", "number": 1 }],
        "tabs": [{ "tab_id": "w1:t1", "workspace_id": "w1", "label": "1", "number": 1 }],
        "panes": panes } })
}

/// One agent in each state, in an order that is not the inbox's.
pub fn panes() -> Vec<Value> {
    vec![
        pane("t4", "idle", json!({ "title": RESTS })),
        pane("t3", "done", json!({ "title": DONE, "finish_id": 2 })),
        pane(
            "t2",
            "working",
            json!({ "title": WORKS, "agent_progress": 40 }),
        ),
        pane(
            "t1",
            "blocked",
            json!({ "title": ASKS, "agent_kind": "question", "agent_message": QUESTION }),
        ),
    ]
}

pub fn card(more: Value) -> Value {
    let mut prompt = json!({ "id": "p1", "agent": "claude", "kind": "question", "title": "Tests", "question": QUESTION,
        "body": null, "multi_select": false, "custom_option_index": 3,
        "options": [{ "label": "bun test", "description": "The repository's own runner." },
                    { "label": "vitest", "description": null }, { "label": "jest", "description": null }] });
    if let (Some(fields), Some(more)) = (prompt.as_object_mut(), more.as_object()) {
        fields.extend(more.clone());
    }
    json!({ "prompt": prompt })
}

pub fn chat() -> Value {
    json!({ "source": "claude-transcript", "turns": [
        { "role": "user", "ts": null, "parts": [{ "kind": "text", "text": ASKS }] },
        { "role": "assistant", "ts": null, "parts": [
            { "kind": "text", "text": "a note along the way" },
            { "kind": "tool", "name": "bash", "summary": "ls", "input": "", "output": "" },
            { "kind": "text", "text": "Created the crate." }] }] })
}

fn ok(body: Value) -> Answers {
    vec![(200, body)]
}

/// The routes of a healthy server over `panes`; a later entry for the same route replaces these.
pub fn routes(panes: &[Value]) -> Vec<(&'static str, Answers)> {
    vec![
        (
            "GET /api/health",
            ok(json!({ "ok": true, "herdr": { "runtime": "herdr-core" } })),
        ),
        ("GET /api/session", ok(session(panes))),
        ("GET /api/seen", ok(json!({ "finishes": [] }))),
        ("GET /api/pane/prompt?pane_id=t1", ok(card(json!({})))),
        ("GET /api/pane/conversation?pane_id=t1", ok(chat())),
        (
            "GET /api/pane/prompt?pane_id=t2",
            ok(json!({ "prompt": null })),
        ),
        (
            "GET /api/pane/prompt?pane_id=t3",
            ok(json!({ "prompt": null })),
        ),
        (
            "GET /api/pane/prompt?pane_id=t4",
            ok(json!({ "prompt": null })),
        ),
        (
            "GET /api/pane/conversation?pane_id=t2",
            ok(json!({ "source": "scrollback", "turns": [], "unavailable": "not_found" })),
        ),
        ("GET /api/pane/conversation?pane_id=t3", ok(chat())),
        ("GET /api/pane/conversation?pane_id=t4", ok(chat())),
    ]
}

/// A healthy server over the four agents.
pub fn healthy() -> Site {
    Site::serve(routes(&panes()))
}

/// The healthy server with some of its routes answering otherwise.
pub fn with(more: Vec<(&'static str, Answers)>) -> Site {
    let mut all = routes(&panes());
    all.extend(more);
    Site::serve(all)
}

/// An origin where nothing answers: a port that was free a moment ago.
pub fn nowhere() -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let origin = format!("http://{}", listener.local_addr().expect("address"));
    drop(listener);
    origin
}

pub const WIDE: (u16, u16) = (120, 40);
pub const PHONE: (u16, u16) = (50, 30);

pub struct World {
    pub state: State,
    client: Client,
}

impl World {
    /// A screen of `size` over the server at `origin`, its first reads made; what those reads
    /// ask beyond calls to the server comes back with it.
    pub fn resumed(origin: &str, size: (u16, u16), resume: Option<Place>) -> (World, Vec<Effect>) {
        let client = Client::new(Server {
            origin: origin.to_owned(),
            token: None,
        });
        let state = State::new(Setup {
            origin: origin.to_owned(),
            narrow_at: NARROW_AT,
            size,
            resume,
        });
        let mut world = World { state, client };
        let first = world.state.start();
        let rest = ui::settle(&mut world.state, &world.client, first);
        (world, rest)
    }

    pub fn open(site: &Site, size: (u16, u16)) -> World {
        Self::resumed(&site.origin, size, None).0
    }

    /// A key, with every call it asks for made; what it asks beyond calls comes back.
    pub fn key(&mut self, intent: Intent) -> Vec<Effect> {
        self.on(Event::Key(intent))
    }

    /// Something the live subscription told, with every call it asks for made.
    pub fn told(&mut self, event: LiveEvent) -> Vec<Effect> {
        self.on(Event::Net(Reply::Live(event)))
    }

    pub fn on(&mut self, event: Event) -> Vec<Effect> {
        let effects = self.state.on(event);
        ui::settle(&mut self.state, &self.client, effects)
    }

    /// One frame at the screen's size: its rows as text, and where a tap lands.
    pub fn frame(&mut self) -> (Vec<String>, Hits) {
        let area = Rect::new(0, 0, self.state.size.0, self.state.size.1);
        let mut buffer = Buffer::empty(area);
        let hits = ui::draw(
            &mut buffer,
            area,
            &Scene {
                state: &self.state,
                colors: &Colors::default(),
                terminal_key: "ctrl+b q",
            },
        );
        self.state.drawn(&hits);
        (ui::rows_of(&buffer), hits)
    }

    pub fn rows(&mut self) -> Vec<String> {
        self.frame().0
    }

    /// The rows of the list alone: what is left of the divider where there is one.
    pub fn list(&mut self) -> Vec<String> {
        self.rows()
            .into_iter()
            .map(|row| row.split('│').next().unwrap_or_default().to_owned())
            .collect()
    }

    /// The screen row whose list part shows `words`.
    pub fn list_row(&mut self, words: &str) -> usize {
        let list = self.list();
        list.iter()
            .position(|row| row.contains(words))
            .unwrap_or_else(|| panic!("no list row shows {words:?}:\n{}", list.join("\n")))
    }

    pub fn shows(&mut self, words: &str) -> bool {
        self.rows().iter().any(|row| row.contains(words))
    }

    pub fn selected(&self) -> Option<&str> {
        self.state.selected.as_deref()
    }
}
