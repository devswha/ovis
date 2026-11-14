use ovis_tui_client::resume::{Place, Spot};
use ovis_tui_client::ui::{Effect, Event, Intent, Page};

use crate::world::{PHONE, WIDE, World, healthy, nowhere};

fn place(spot: Spot, pane: &str) -> Option<Place> {
    Some(Place {
        core: "/run/hc.sock".into(),
        spot,
        pane: Some(pane.into()),
    })
}

#[test]
fn a_run_cut_off_on_a_card_comes_back_to_that_card() {
    let site = healthy();
    let (phone, rest) = World::resumed(&site.origin, PHONE, place(Spot::Card, "t3"));
    assert_eq!(
        (phone.selected(), phone.state.page),
        (Some("t3"), Page::Card)
    );
    assert!(
        !rest
            .iter()
            .any(|effect| matches!(effect, Effect::OpenTerminal(_)))
    );
    // a wide screen has the card beside the list: there is no card page to come back to
    let (wide, _) = World::resumed(&site.origin, WIDE, place(Spot::Card, "t3"));
    assert_eq!((wide.selected(), wide.state.page), (Some("t3"), Page::List));
}

#[test]
fn a_run_cut_off_in_a_terminal_reopens_the_terminal_screen_where_it_was_left() {
    let site = healthy();
    let (world, rest) = World::resumed(&site.origin, PHONE, place(Spot::Terminal, "t2"));
    assert_eq!(world.selected(), Some("t2"));
    assert!(rest.contains(&Effect::OpenTerminal(None)), "{rest:?}");
}

#[test]
fn a_place_whose_agent_is_gone_falls_back_to_the_first_row() {
    let site = healthy();
    let (card, rest) = World::resumed(&site.origin, PHONE, place(Spot::Card, "t99"));
    assert_eq!((card.selected(), card.state.page), (Some("t1"), Page::List));
    assert!(
        !rest
            .iter()
            .any(|effect| matches!(effect, Effect::OpenTerminal(_)))
    );
    let (terminal, rest) = World::resumed(&site.origin, PHONE, place(Spot::Terminal, "t99"));
    assert_eq!(terminal.selected(), Some("t1"));
    assert!(rest.contains(&Effect::OpenTerminal(None)), "{rest:?}");
}

#[test]
fn with_no_server_a_run_cut_off_in_a_terminal_still_reopens_it() {
    let origin = nowhere();
    let (_, rest) = World::resumed(&origin, PHONE, place(Spot::Terminal, "t2"));
    assert_eq!(rest, [Effect::OpenTerminal(None)]);
    let (_, rest) = World::resumed(&origin, PHONE, place(Spot::Card, "t2"));
    assert_eq!(rest, []);
}

#[test]
fn the_place_is_told_as_the_user_moves_and_when_they_leave() {
    let site = healthy();
    let mut world = World::open(&site, PHONE);
    let remember = |spot, pane: &str| Effect::Remember {
        spot,
        pane: Some(pane.into()),
    };
    assert!(
        world
            .key(Intent::Down)
            .contains(&remember(Spot::Inbox, "t2"))
    );
    assert_eq!(world.key(Intent::Open), [remember(Spot::Card, "t2")]);
    world.key(Intent::Help);
    // the help page is no place of its own: the page under it is
    assert_eq!(world.key(Intent::Quit), []);
    assert_eq!(world.key(Intent::Back), [remember(Spot::Inbox, "t2")]);
    assert_eq!(
        world.key(Intent::Quit),
        [remember(Spot::Inbox, "t2"), Effect::Quit]
    );
}

#[test]
fn coming_back_from_the_terminal_reads_everything_again_and_says_how_it_ended() {
    let site = healthy();
    let mut world = World::open(&site, WIDE);
    site.asked();
    let rest = world.on(Event::TerminalClosed(Some("the core went away".into())));
    assert_eq!(
        rest,
        [Effect::Remember {
            spot: Spot::Inbox,
            pane: Some("t1".into())
        }]
    );
    assert!(
        world
            .state
            .notice
            .as_deref()
            .is_some_and(|notice| notice.contains("the core went away"))
    );
    let mut routes = site.routes();
    routes.sort();
    assert_eq!(
        routes,
        [
            "GET /api/health",
            "GET /api/pane/conversation?pane_id=t1",
            "GET /api/pane/prompt?pane_id=t1",
            "GET /api/seen",
            "GET /api/session"
        ]
    );
    world.on(Event::TerminalClosed(None));
    assert_eq!(world.state.notice, None);
}
