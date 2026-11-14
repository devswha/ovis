use ovis_tui_client::inbox::Group;
use ovis_tui_client::resume::Spot;
use ovis_tui_client::ui::{Effect, Event, Intent, Page, Target};
use serde_json::json;
use unicode_width::UnicodeWidthStr;

use crate::world::{ASKS, DONE, PHONE, WIDE, WORKS, World, card, healthy, with};

#[test]
fn enter_goes_to_the_terminal_of_the_selected_agent_through_its_card_on_a_phone() {
    let site = healthy();
    let terminal = vec![
        Effect::Remember {
            spot: Spot::Terminal,
            pane: Some("t1".into()),
        },
        Effect::OpenTerminal(Some("t1".into())),
    ];
    let mut wide = World::open(&site, WIDE);
    assert_eq!(wide.key(Intent::Open), terminal);
    let mut phone = World::open(&site, PHONE);
    assert_eq!(
        phone.key(Intent::Open),
        [Effect::Remember {
            spot: Spot::Card,
            pane: Some("t1".into())
        }]
    );
    assert_eq!(phone.state.page, Page::Card);
    assert_eq!(phone.key(Intent::Open), terminal);
    let mut direct = World::open(&site, PHONE);
    assert_eq!(direct.key(Intent::Terminal), terminal);
}

#[test]
fn a_classic_herdr_servers_agents_are_not_opened_in_this_terminal_screen() {
    let site = with(vec![(
        "GET /api/health",
        vec![(
            200,
            json!({ "ok": true, "herdr": { "version": "0.9.5", "protocol": 22 } }),
        )],
    )]);
    let mut world = World::open(&site, WIDE);
    assert_eq!(world.key(Intent::Open), []);
    assert!(world.state.notice.is_some());
}

#[test]
fn m_tells_the_server_the_finish_was_looked_at_and_the_row_comes_to_rest() {
    let read = json!({ "pc": "local", "epoch": "e1", "pane": "t3", "id": 2 });
    let site = with(vec![("POST /api/seen", vec![(200, read)])]);
    let mut world = World::open(&site, WIDE);
    world.key(Intent::Down);
    world.key(Intent::Down);
    assert_eq!(world.selected(), Some("t3"));
    site.asked();
    world.key(Intent::MarkRead);
    assert_eq!(
        site.posts(),
        [(
            "POST /api/seen".to_owned(),
            Some(
                json!({ "pc": "local", "epoch": "e1", "pane": "t3", "id": 2, "presented": "new" })
            )
        )]
    );
    let resting: Vec<&str> = world
        .state
        .groups
        .iter()
        .filter(|(group, _)| *group == Group::Idle)
        .flat_map(|(_, rows)| rows.iter().map(|row| row.pane_id.as_str()))
        .collect();
    assert!(resting.contains(&"t3"), "{resting:?}");
    world.key(Intent::MarkRead);
    assert_eq!(site.posts(), []);
    assert!(world.state.notice.is_some());
}

#[test]
fn a_tap_selects_a_row_and_on_a_phone_opens_its_card() {
    let site = healthy();
    let mut wide = World::open(&site, WIDE);
    let row = u16::try_from(wide.list_row(WORKS)).expect("a row");
    let (_, hits) = wide.frame();
    assert_eq!(hits.at(5, row), Some(Target::Row("t2".into())));
    // the same row, right of the divider: that is the card, not the list
    assert_eq!(hits.at(90, row), None);
    assert_eq!(hits.at(5, 0), None);
    wide.on(Event::Tap(Target::Row("t2".into())));
    assert_eq!((wide.selected(), wide.state.page), (Some("t2"), Page::List));

    let mut phone = World::open(&site, PHONE);
    let row = u16::try_from(phone.list_row(DONE)).expect("a row");
    let (_, hits) = phone.frame();
    let target = hits.at(40, row).expect("a row under the tap");
    phone.on(Event::Tap(target));
    assert_eq!(
        (phone.selected(), phone.state.page),
        (Some("t3"), Page::Card)
    );
    let (rows, hits) = phone.frame();
    let back = u16::try_from(
        rows.iter()
            .position(|row| row.contains('‹'))
            .expect("a back mark"),
    )
    .expect("a row");
    phone.on(Event::Tap(
        hits.at(1, back).expect("the back mark takes a tap"),
    ));
    assert_eq!(phone.state.page, Page::List);
}

/// The last row of the screen as its hints: each a key and what it does.
fn hints(world: &mut World) -> Vec<String> {
    let line = world.rows().pop().expect("a last row");
    line.split("  ").map(str::to_owned).collect()
}

fn key_of(hint: &str) -> &str {
    hint.split(' ').next().unwrap_or_default()
}

#[test]
fn a_phone_gets_the_most_wanted_key_hints_whole_and_the_answer_keys_first_beside_a_card() {
    let site = healthy();
    for page in [None, Some(Intent::Open), Some(Intent::Help)] {
        // 64 columns is the widest phone layout: what a narrower one shows is cut from it
        let mut roomy = World::open(&site, (64, 20));
        let mut tight = World::open(&site, (45, 20));
        for world in [&mut roomy, &mut tight] {
            if let Some(key) = page {
                world.key(key);
            }
        }
        let all = hints(&mut roomy);
        let shown = hints(&mut tight);
        assert!(!shown.is_empty() && shown.len() <= all.len(), "{page:?}");
        assert_eq!(shown, all[..shown.len()], "{page:?}");
        assert!(shown.join("  ").width() <= 45, "{page:?}: {shown:?}");
    }
    let mut phone = World::open(&site, (45, 20));
    assert_eq!(key_of(&hints(&mut phone)[0]), "enter");
    phone.key(Intent::Open);
    assert_eq!(key_of(&hints(&mut phone)[0]), "1-3");
    let mut wide = World::open(&site, WIDE);
    assert_eq!(key_of(&hints(&mut wide)[0]), "1-3");
    wide.key(Intent::Down);
    assert_eq!(key_of(&hints(&mut wide)[0]), "enter");
}

#[test]
fn a_card_that_scrolls_on_the_narrowest_phone_still_names_the_way_back() {
    let options: Vec<_> = (1..=9)
        .map(|n| json!({ "label": format!("option-{n}"), "description": null }))
        .collect();
    let tall = card(json!({ "options": options, "custom_option_index": null }));
    let site = with(vec![("GET /api/pane/prompt?pane_id=t1", vec![(200, tall)])]);
    let mut world = World::open(&site, (45, 20));
    world.key(Intent::Open);
    let (_, hits) = world.frame();
    assert!(hits.scroll_max > 0);
    let shown = hints(&mut world);
    let keys: Vec<&str> = shown.iter().map(|hint| key_of(hint)).collect();
    assert!(keys.contains(&"b"), "{keys:?}");
}

#[test]
fn moving_the_selection_reads_the_next_agents_card_and_stops_at_both_ends() {
    let site = healthy();
    let mut world = World::open(&site, WIDE);
    site.asked();
    assert_eq!(world.key(Intent::Up), []);
    assert_eq!(site.routes(), Vec::<String>::new());
    assert_eq!(
        world.key(Intent::Down),
        [
            Effect::Watch(Some("t2".into())),
            Effect::Remember {
                spot: Spot::Inbox,
                pane: Some("t2".into())
            }
        ]
    );
    assert_eq!(
        site.routes(),
        [
            "GET /api/pane/prompt?pane_id=t2",
            "GET /api/pane/conversation?pane_id=t2"
        ]
    );
    world.key(Intent::Bottom);
    assert_eq!(world.selected(), Some("t4"));
    assert_eq!(world.key(Intent::Down), []);
    world.key(Intent::Top);
    assert_eq!(world.selected(), Some("t1"));
    assert!(world.shows(ASKS));
}
