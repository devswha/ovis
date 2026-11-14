use ovis_tui_client::api::SeenFinish;
use ovis_tui_client::inbox::Group;
use ovis_tui_client::live::LiveEvent;
use ovis_tui_client::ui::{Effect, Front, Intent, Link};
use serde_json::json;

use crate::site::Site;
use crate::world::{ASKS, PHONE, WIDE, World, healthy, panes, routes};

fn group_of(world: &World, pane: &str) -> Option<Group> {
    world
        .state
        .groups
        .iter()
        .find(|(_, rows)| rows.iter().any(|row| row.pane_id == pane))
        .map(|(group, _)| *group)
}

fn status(pane: &str, state: &str, finish: Option<u64>) -> LiveEvent {
    LiveEvent::PaneStatus {
        pane_id: pane.into(),
        agent_status: state.into(),
        finish_id: finish,
        finish_epoch: Some("e1".into()),
    }
}

#[test]
fn a_pushed_status_moves_the_row_without_reading_the_session_again() {
    let site = healthy();
    let mut world = World::open(&site, WIDE);
    site.asked();
    world.told(status("t2", "blocked", None));
    assert_eq!(group_of(&world, "t2"), Some(Group::NeedsYou));
    world.told(status("t2", "done", Some(5)));
    assert_eq!(group_of(&world, "t2"), Some(Group::Done));
    assert_eq!(site.routes(), Vec::<String>::new());
    // the selected agent's own status may open or close its card: that one is read again
    world.told(status("t1", "working", None));
    assert_eq!(site.routes(), ["GET /api/pane/prompt?pane_id=t1"]);
}

#[test]
fn a_changed_card_or_chat_is_read_again_for_the_selected_agent_alone() {
    let site = healthy();
    let mut world = World::open(&site, WIDE);
    site.asked();
    world.told(LiveEvent::PromptChanged("t2".into()));
    world.told(LiveEvent::ConversationChanged("t3".into()));
    assert_eq!(site.routes(), Vec::<String>::new());
    world.told(LiveEvent::PromptChanged("t1".into()));
    world.told(LiveEvent::ConversationChanged("t1".into()));
    assert_eq!(
        site.routes(),
        [
            "GET /api/pane/prompt?pane_id=t1",
            "GET /api/pane/conversation?pane_id=t1"
        ]
    );
}

#[test]
fn an_agent_that_exits_leaves_the_list_and_the_selection_moves_to_the_first_row() {
    let site = healthy();
    let mut world = World::open(&site, WIDE);
    site.asked();
    let rest = world.told(LiveEvent::PaneExited("t1".into()));
    assert!(!world.shows(ASKS));
    assert_eq!(world.selected(), Some("t2"));
    assert_eq!(rest, [Effect::Watch(Some("t2".into()))]);
    assert_eq!(
        site.routes(),
        [
            "GET /api/pane/prompt?pane_id=t2",
            "GET /api/pane/conversation?pane_id=t2"
        ]
    );
}

#[test]
fn a_dropped_subscription_reads_as_offline_until_the_server_answers_again() {
    let site = healthy();
    let mut world = World::open(&site, WIDE);
    world.told(LiveEvent::Down("connection reset".into()));
    assert_eq!(world.state.link, Link::Down("connection reset".into()));
    site.asked();
    world.told(LiveEvent::Up);
    assert_eq!(world.state.link, Link::Up);
    let mut routes = site.routes();
    routes.sort();
    assert_eq!(
        routes,
        ["GET /api/health", "GET /api/seen", "GET /api/session"]
    );
}

#[test]
fn the_finish_in_front_of_the_user_is_the_selected_agents_while_its_card_is_on_screen() {
    let site = healthy();
    let unread = SeenFinish {
        pc: "local".into(),
        epoch: "e1".into(),
        pane: "t3".into(),
        id: 2,
        answer: None,
    };
    let mut wide = World::open(&site, WIDE);
    assert_eq!(
        wide.state.front(),
        Front {
            pane: Some("t1".into()),
            unread: None
        }
    );
    wide.key(Intent::Down);
    wide.key(Intent::Down);
    assert_eq!(
        wide.state.front(),
        Front {
            pane: Some("t3".into()),
            unread: Some(unread.clone())
        }
    );
    wide.key(Intent::Help);
    assert_eq!(wide.state.front(), Front::default());

    let mut phone = World::open(&site, PHONE);
    phone.key(Intent::Down);
    phone.key(Intent::Down);
    assert_eq!(phone.state.front(), Front::default());
    phone.key(Intent::Open);
    assert_eq!(phone.state.front().unread, Some(unread));
}

#[test]
fn a_finish_another_device_read_stops_being_in_front() {
    let mut all = routes(&panes());
    all.push((
        "GET /api/seen",
        vec![
            (200, json!({ "finishes": [] })),
            (
                200,
                json!({ "finishes": [{ "pc": "local", "epoch": "e1", "pane": "t3", "id": 2 }] }),
            ),
        ],
    ));
    let site = Site::serve(all);
    let mut world = World::open(&site, WIDE);
    world.key(Intent::Down);
    world.key(Intent::Down);
    assert!(world.state.front().unread.is_some());
    world.key(Intent::Refresh);
    assert_eq!(world.state.front().unread, None);
    assert_eq!(group_of(&world, "t3"), Some(Group::Idle));
}
