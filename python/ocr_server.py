"""OCR server dùng RapidOCR, giao tiếp với Electron qua stdin/stdout (mỗi dòng 1 JSON).

Request : {"id": 1, "path": "C:/.../shot.png"}
Response: {"id": 1, "ok": true, "lines": [{"text": "...", "score": 0.98, "box": [[x,y],...]}]}

Hỗ trợ cả 2 gói:
  pip install rapidocr_onnxruntime      (API cũ, ổn định)
  pip install rapidocr onnxruntime      (API mới v2/v3)
"""
import io
import json
import os
import sys

# Giữ stdout thật cho JSON, mọi log của thư viện đẩy sang stderr
REAL_OUT = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)
sys.stdout = sys.stderr
sys.stdin.reconfigure(encoding="utf-8")


def send(obj):
    REAL_OUT.write(json.dumps(obj, ensure_ascii=False) + "\n")
    REAL_OUT.flush()


THREADS = int(os.environ.get("OCR_THREADS", "4") or 4)

engine = None
mode = None


def make_legacy():
    from rapidocr_onnxruntime import RapidOCR  # type: ignore
    # giới hạn luồng để OCR không chiếm hết CPU (bản cũ không nhận tham số → bỏ qua)
    for kw in ({"intra_op_num_threads": THREADS, "inter_op_num_threads": 1}, {}):
        try:
            return RapidOCR(**kw)
        except TypeError:
            continue
    return RapidOCR()


def make_new():
    from rapidocr import RapidOCR  # type: ignore
    try:
        return RapidOCR(params={
            "EngineConfig.onnxruntime.intra_op_num_threads": THREADS,
            "EngineConfig.onnxruntime.inter_op_num_threads": 1,
        })
    except Exception:  # noqa: BLE001
        return RapidOCR()


try:
    engine = make_legacy()
    mode = "legacy"
except ImportError:
    try:
        engine = make_new()
        mode = "new"
    except ImportError as e:
        send({"id": 0, "ok": False, "fatal": True,
              "error": "Chưa cài RapidOCR. Chạy: pip install rapidocr_onnxruntime  (" + str(e) + ")"})
        sys.exit(1)


def to_list(v):
    return v.tolist() if hasattr(v, "tolist") else v


# Ngưỡng nới lỏng hơn mặc định để không bỏ sót chữ nhỏ / chữ mờ
TUNE = {"text_score": 0.3, "box_thresh": 0.3, "unclip_ratio": 1.8}


def preprocess(path):
    """Đọc ảnh và làm cho dễ nhận dạng hơn. Trả về (ảnh, scale, pad) để quy đổi toạ độ ngược lại.
    - Nền tối (dark mode) → đảo màu thành chữ tối trên nền sáng (model nhận tốt hơn hẳn)
    - Ảnh nhỏ → phóng to (chữ ~12–14px trên màn hình thường bị bỏ sót)
    - Thêm viền: chữ sát mép vùng chọn hay bị mất
    """
    import cv2  # đi kèm RapidOCR
    import numpy as np

    img = cv2.imdecode(np.fromfile(path, dtype=np.uint8), cv2.IMREAD_COLOR)  # hỗ trợ đường dẫn Unicode
    if img is None:
        return path, 1.0, 0
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    if float(gray.mean()) < 110:
        img = 255 - img
    h, w = img.shape[:2]
    scale = 1.0
    if max(h, w) < 1600:
        scale = min(2.5, 1600.0 / max(h, w), 3200.0 / max(1, max(h, w)))
        if scale > 1.15:
            img = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
        else:
            scale = 1.0
    pad = 24
    edge = np.concatenate([img[0], img[-1], img[:, 0], img[:, -1]])
    color = [int(c) for c in np.median(edge, axis=0)]
    img = cv2.copyMakeBorder(img, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=color)
    return img, scale, pad


def call_engine(img):
    try:
        return engine(img, **TUNE)
    except TypeError:  # phiên bản không nhận tham số tinh chỉnh
        return engine(img)


def raw_lines(img):
    lines = []
    if mode == "legacy":
        result, _ = call_engine(img)
        for box, text, score in result or []:
            lines.append({"text": text, "score": float(score), "box": to_list(box)})
    else:
        out = call_engine(img)
        txts = getattr(out, "txts", None) or ()
        scores = getattr(out, "scores", None) or [1.0] * len(txts)
        boxes = getattr(out, "boxes", None)
        boxes = to_list(boxes) if boxes is not None else [None] * len(txts)
        for t, s, b in zip(txts, scores, boxes):
            lines.append({"text": t, "score": float(s), "box": b})
    return lines


def run(path):
    if not isinstance(path, str):  # ảnh numpy (dùng cho warm-up)
        return raw_lines(path)
    try:
        img, scale, pad = preprocess(path)
    except Exception:  # noqa: BLE001
        img, scale, pad = path, 1.0, 0
    lines = raw_lines(img)
    if not lines and not isinstance(img, str):
        lines = raw_lines(path)  # dự phòng: thử ảnh gốc
        scale, pad = 1.0, 0
    # quy đổi toạ độ khung về ảnh gốc
    for ln in lines:
        if ln["box"]:
            ln["box"] = [[(p[0] - pad) / scale, (p[1] - pad) / scale] for p in ln["box"]]
    return lines


send({"id": 0, "ok": True, "ready": True, "engine": mode})

# chạy thử 1 lần với ảnh nhỏ để lần OCR thật đầu tiên không bị chậm
try:
    import numpy as np  # có sẵn cùng onnxruntime
    _img = np.full((48, 160, 3), 255, dtype=np.uint8)
    run(_img)
except Exception:  # noqa: BLE001
    pass

for raw in sys.stdin:
    raw = raw.strip()
    if not raw:
        continue
    req_id = None
    try:
        req = json.loads(raw)
        req_id = req.get("id")
        send({"id": req_id, "ok": True, "lines": run(req["path"])})
    except Exception as e:  # noqa: BLE001
        send({"id": req_id, "ok": False, "error": repr(e)})
