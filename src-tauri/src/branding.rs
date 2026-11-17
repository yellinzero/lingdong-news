pub fn language_for(preference: &str, system_locale: &str) -> &'static str {
    match preference {
        "en" => "en",
        "zh-CN" => "zh-CN",
        _ if system_locale
            .split(['-', '_', '.'])
            .next()
            .is_some_and(|lang| lang.eq_ignore_ascii_case("en")) =>
        {
            "en"
        }
        _ => "zh-CN",
    }
}
pub fn language(preference: &str) -> &'static str {
    language_for(preference, &sys_locale::get_locale().unwrap_or_default())
}
pub fn text(preference: &str, chinese: &'static str, english: &'static str) -> &'static str {
    if language(preference) == "en" {
        english
    } else {
        chinese
    }
}
pub fn name_for_locale(locale: &str) -> &'static str {
    if language_for("system", locale) == "en" {
        "LingDongNews"
    } else {
        "灵动新闻"
    }
}
pub fn name(preference: &str) -> &'static str {
    text(preference, "灵动新闻", "LingDongNews")
}
pub fn app_name() -> &'static str {
    name_for_locale(&sys_locale::get_locale().unwrap_or_default())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn system_language_uses_chinese_unless_english() {
        for locale in [
            "zh",
            "zh-CN",
            "zh-Hant-TW",
            "zh_CN.UTF-8",
            "ZH-hk",
            "ja-JP",
            "de-DE",
            "",
            "zhong",
        ] {
            assert_eq!(name_for_locale(locale), "灵动新闻");
        }
        for locale in ["en", "en-US", "en_GB", "EN-us"] {
            assert_eq!(name_for_locale(locale), "LingDongNews");
        }
    }
    #[test]
    fn manual_language_overrides_system_and_old_preferences_default_to_system() {
        assert_eq!(language_for("en", "zh-CN"), "en");
        assert_eq!(language_for("zh-CN", "en-US"), "zh-CN");
        assert_eq!(language_for("system", "fr-FR"), "zh-CN");
        let old: crate::model::Preferences = serde_json::from_str("{}").unwrap();
        assert_eq!(old.language, "system");
        let mut prefs = old;
        prefs.language = "en".into();
        let restored: crate::model::Preferences =
            serde_json::from_str(&serde_json::to_string(&prefs).unwrap()).unwrap();
        assert_eq!(restored.language, "en");
    }
}
