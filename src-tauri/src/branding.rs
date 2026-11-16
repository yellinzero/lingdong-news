pub fn name_for_locale(locale: &str) -> &'static str {
    if locale
        .split(['-', '_', '.'])
        .next()
        .is_some_and(|lang| lang.eq_ignore_ascii_case("zh"))
    {
        "灵动新闻"
    } else {
        "LingDongNews"
    }
}

pub fn app_name() -> &'static str {
    name_for_locale(&sys_locale::get_locale().unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_language_selects_name_without_changing_app_identity() {
        for locale in [
            "zh",
            "zh-CN",
            "zh-Hans-CN",
            "zh-Hant-TW",
            "zh_CN.UTF-8",
            "ZH-hk",
        ] {
            assert_eq!(name_for_locale(locale), "灵动新闻");
        }
        for locale in ["en-US", "en_GB", "ja-JP", "de-DE", "", "zhong"] {
            assert_eq!(name_for_locale(locale), "LingDongNews");
        }
    }
}
