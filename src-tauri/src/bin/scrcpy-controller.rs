#[path = "../cli_client.rs"]
mod cli_client;
#[path = "../cli_protocol.rs"]
mod cli_protocol;

fn main() -> std::process::ExitCode {
    cli_client::run(false)
}
