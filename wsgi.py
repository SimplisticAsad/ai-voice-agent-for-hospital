import os

from dotenv import load_dotenv

load_dotenv()

from flask import Flask, jsonify, render_template  # noqa: E402
from flask_cors import CORS  # noqa: E402

from app.database import init_db  # noqa: E402
from app.routes.patients import bp as patients_bp  # noqa: E402
from app.routes.voice import bp as voice_bp  # noqa: E402


def create_app():
    app = Flask(__name__, template_folder="templates")
    CORS(app)
    init_db()

    app.register_blueprint(patients_bp)
    app.register_blueprint(voice_bp)

    @app.before_request
    def log_request():
        from flask import request

        print(f"[http] {request.method} {request.path}")

    @app.get("/")
    def dashboard():
        return render_template("dashboard.html")

    @app.get("/health")
    def health():
        return jsonify({"data": {"status": "ok"}, "error": None}), 200

    @app.errorhandler(404)
    def not_found(_err):
        return jsonify({"data": None, "error": "Not found"}), 404

    @app.errorhandler(Exception)
    def handle_error(err):
        from werkzeug.exceptions import HTTPException

        if isinstance(err, HTTPException):
            return err
        print("Server error:", err)
        return jsonify({"data": None, "error": "Internal server error"}), 500

    return app


app = create_app()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 3000))
    print(f"AI Voice Agent for Hospital running on port {port}")
    print(f"Dashboard: http://localhost:{port}")
    print(f"REST API:  http://localhost:{port}/patients")
    print(f"Twilio voice webhook: POST http://localhost:{port}/voice/incoming")
    app.run(host="0.0.0.0", port=port, debug=False)
