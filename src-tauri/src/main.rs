#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    let args: Vec<_> = std::env::args().collect();
    if let Some(index) = args.iter().position(|a| a == "--check-ai") {
        let Some(path) = args.get(index + 1) else {
            eprintln!("需要凭据文件路径");
            std::process::exit(1);
        };
        std::process::exit(lingdong_news::check_ai(std::path::Path::new(path)));
    }
    if let Some(index) = args.iter().position(|a| a == "--check-source-file") {
        let Some(path) = args.get(index + 1) else {
            std::process::exit(1);
        };
        std::process::exit(lingdong_news::check_source_file(std::path::Path::new(path)));
    }
    if std::env::args().any(|a| a == "--check-storage") {
        lingdong_news::check_storage();
        return;
    }
    if std::env::args().any(|a| a == "--check-sources") {
        lingdong_news::check_sources();
        return;
    }
    lingdong_news::run();
}
