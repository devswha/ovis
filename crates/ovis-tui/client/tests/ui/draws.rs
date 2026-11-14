use ovis_tui_client::ui::{Effect, Intent, Link, Page};
use serde_json::json;
use unicode_width::UnicodeWidthStr;

use crate::site::Site;
use crate::world::{
    ASKS, DONE, PHONE, QUESTION, RESTS, WIDE, WORKS, World, card, healthy, nowhere, pane, panes,
    routes,
};

#[test]
fn the_list_puts_who_needs_you_first_then_working_done_and_resting() {
    let site = healthy();
    for size in [WIDE, PHONE] {
        let mut world = World::open(&site, size);
        let at = [ASKS, WORKS, DONE, RESTS].map(|title| world.list_row(title));
        assert!(at.is_sorted(), "{size:?}: rows at {at:?}");
    }
}

#[test]
fn a_wide_screen_shows_the_selected_agents_card_beside_the_list() {
    let site = healthy();
    let mut world = World::open(&site, WIDE);
    let rows = world.rows();
    let card: Vec<&str> = rows
        .iter()
        .filter_map(|row| row.split_once('│').map(|(_, card)| card))
        .collect();
    assert!(card.iter().any(|line| line.contains(QUESTION)));
    for option in ["1 bun test", "2 vitest", "3 jest"] {
        assert!(card.iter().any(|line| line.contains(option)), "{option}");
    }
    // of the agent's last turn, its last message: not its notes along the way
    assert!(card.iter().any(|line| line.contains("Created the crate.")));
    assert!(
        !card
            .iter()
            .any(|line| line.contains("a note along the way"))
    );
}

#[test]
fn a_phone_shows_one_thing_at_a_time() {
    let site = healthy();
    let mut world = World::open(&site, PHONE);
    assert!(!world.shows("│") && !world.shows(QUESTION));
    assert!(world.shows(WORKS));
    world.key(Intent::Open);
    assert_eq!(world.state.page, Page::Card);
    assert!(world.shows(QUESTION) && world.shows("2 vitest"));
    assert!(!world.shows("│") && !world.shows(WORKS));
    world.key(Intent::Back);
    assert!(world.shows(WORKS) && !world.shows(QUESTION));
}

#[test]
fn no_row_is_wider_than_its_screen_whatever_an_agent_calls_itself() {
    let long = "재시도 정책을 문서로 정리하고 예제까지 붙이는 아주 긴 작업 이름 with a very long tail of words";
    let mut named = panes();
    named.push(pane(
        "t5",
        "blocked",
        json!({ "title": long, "agent_kind": "permission" }),
    ));
    named.push(pane(
        "t6",
        "done",
        json!({ "title": "한글", "finish_id": 1, "agent": "오래된-에이전트-이름" }),
    ));
    let site = Site::serve(routes(&named));
    for size in [
        (45, 20),
        PHONE,
        (64, 24),
        (65, 24),
        (80, 24),
        WIDE,
        (200, 50),
    ] {
        let mut world = World::open(&site, size);
        let mut pages = vec![world.rows()];
        world.key(Intent::Bottom);
        pages.push(world.rows());
        world.key(Intent::Open);
        pages.push(world.rows());
        world.key(Intent::Help);
        pages.push(world.rows());
        for row in pages.iter().flatten() {
            assert!(row.width() <= usize::from(size.0), "{size:?}: {row:?}");
        }
    }
}

#[test]
fn the_divider_of_a_wide_screen_stands_in_one_column_beside_wide_characters() {
    let mut named = panes();
    named.push(pane(
        "t5",
        "working",
        json!({ "title": "한글 제목의 작업 하나 더" }),
    ));
    let site = Site::serve(routes(&named));
    let mut world = World::open(&site, WIDE);
    let rows = world.rows();
    let body = &rows[2..rows.len() - 2];
    let columns: Vec<Option<usize>> = body
        .iter()
        .map(|row| row.split_once('│').map(|(left, _)| left.width()))
        .collect();
    assert!(columns[0].is_some());
    assert!(
        columns.iter().all(|column| *column == columns[0]),
        "{columns:?}"
    );
}

#[test]
fn an_agents_words_reach_the_screen_without_control_characters() {
    let mut site = routes(&panes());
    let hostile = card(json!({
        "question": "Proceed?\u{1b}[2J\u{1b}]0;gotcha\u{7}",
        "body": "line one\r\nline two\u{8}\u{1b}[31m",
        "options": [{ "label": "yes\u{1b}[H", "description": "it\u{0}is\tfine" }, { "label": "no", "description": null }],
    }));
    site.push(("GET /api/pane/prompt?pane_id=t1", vec![(200, hostile)]));
    let site = Site::serve(site);
    for size in [WIDE, PHONE] {
        let mut world = World::open(&site, size);
        world.key(Intent::Open);
        assert_eq!(world.state.answerable(), 2);
        let rows = world.rows();
        assert!(rows.iter().any(|row| row.contains("Proceed?")));
        let control: Vec<char> = rows
            .iter()
            .flat_map(|row| row.chars())
            .filter(|ch| ch.is_control())
            .collect();
        assert_eq!(control, Vec::<char>::new(), "{size:?}");
        world.key(Intent::Back);
    }
}

#[test]
fn with_no_server_the_screen_names_the_origin_it_asked_and_still_opens_the_terminals() {
    let origin = nowhere();
    for size in [WIDE, PHONE] {
        let (mut world, rest) = World::resumed(&origin, size, None);
        assert!(matches!(world.state.link, Link::Down(_)));
        assert!(world.state.groups.is_empty() && rest.is_empty());
        let shown = world
            .rows()
            .join(" ")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        assert!(shown.contains(&origin), "{shown}");
        let asked = world.key(Intent::Open);
        assert!(asked.contains(&Effect::OpenTerminal(None)), "{asked:?}");
    }
}

#[test]
fn a_server_that_asks_for_its_token_is_told_apart_from_one_that_is_down() {
    let refused = || {
        vec![(
            401,
            json!({ "error": { "code": "unauthorized", "message": "token required" } }),
        )]
    };
    let site = Site::serve(vec![
        ("GET /api/health", vec![(200, json!({ "ok": true }))]),
        ("GET /api/session", refused()),
        ("GET /api/seen", refused()),
    ]);
    let mut world = World::open(&site, PHONE);
    assert_eq!(world.state.link, Link::Refused("token required".into()));
    let asked = world.key(Intent::Open);
    assert!(asked.contains(&Effect::OpenTerminal(None)), "{asked:?}");
}

#[test]
fn a_card_taller_than_the_screen_scrolls_to_its_last_option() {
    let options: Vec<_> = (1..=9)
        .map(|n| json!({ "label": format!("option-{n}"), "description": format!("what option {n} does") }))
        .collect();
    let mut site = routes(&panes());
    site.push((
        "GET /api/pane/prompt?pane_id=t1",
        vec![(
            200,
            card(json!({ "options": options, "custom_option_index": null })),
        )],
    ));
    let site = Site::serve(site);
    let mut world = World::open(&site, (50, 16));
    world.key(Intent::Open);
    let (rows, hits) = world.frame();
    assert!(hits.scroll_max > 0);
    assert!(rows.iter().any(|row| row.contains("1 option-1")));
    assert!(!rows.iter().any(|row| row.contains("9 option-9")));
    for _ in 0..8 {
        world.key(Intent::ScrollDown);
        let (_, hits) = world.frame();
        assert!(world.state.scroll <= hits.scroll_max);
    }
    assert!(world.shows("9 option-9") && !world.shows("1 option-1"));
    world.key(Intent::ScrollUp);
    world.key(Intent::ScrollUp);
    world.key(Intent::ScrollUp);
    assert!(world.shows("1 option-1"));
}
