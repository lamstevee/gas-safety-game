# asset/ 원본 → asset_web/ 게임용 가공본
#   오브젝트: 배경 제거(모서리 연결 플러드필) → 여백 크롭 → 리사이즈 → PNG 양자화
#   배경   : 빈 띠·워터마크 크롭 → 1080x1920 cover → JPEG
# 원본은 건드리지 않는다. 결과가 이상하면 TOL / OBJ_MAX 만 바꿔 다시 돌린다.
#
#   python tools/prep_assets.py
import os, sys
import numpy as np
from PIL import Image, ImageFilter

SRC, DST = 'asset', 'asset_web'
OBJ_MAX   = 800       # 오브젝트 긴 변 상한 (캔버스 1080폭 기준 충분)
BG_W, BG_H = 1080, 1920
TOL_LIGHT = 40        # 밝은 배경 허용 색차
TOL_DARK  = 20        # 어두운 배경은 외곽선과 가까워 좁게
WM_MARGIN = 300       # 배경 우하단 생성 AI 워터마크가 들어가는 여백(원본 px)

# 오브젝트 '안쪽'에 가짜 투명 체커무늬가 칠해져 있어 플러드필이 닿지 않는 파일.
# 해당 면의 실제 색으로 메운다.
REPAINT = {'06obj_light.png': (255, 255, 255)}   # 전등 스위치판 = 흰색


def row_fill(cand, seed):
    """한 행 안에서 연속 구간 단위로 시드를 퍼뜨린다 (경계에서 멈춤)."""
    if not cand.any():
        return np.zeros_like(cand)
    starts = cand & ~np.concatenate(([False], cand[:-1]))
    ids = np.cumsum(starts) * cand
    n = int(ids.max())
    hit = np.zeros(n + 1, bool)
    sel = seed & cand
    if sel.any():
        np.logical_or.at(hit, ids[sel], True)
    hit[0] = False
    return hit[ids]


def dilate(m):
    d = m.copy()
    d[1:] |= m[:-1]; d[:-1] |= m[1:]
    d[:, 1:] |= m[:, :-1]; d[:, :-1] |= m[:, 1:]
    return d


def bg_mask(rgb, tol):
    """테두리에서 연결된 배경 픽셀 마스크. 오브젝트 안쪽 같은 색은 남는다."""
    h, w, _ = rgb.shape
    border = np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]])
    seed = np.median(border, axis=0)
    cand = np.abs(rgb - seed).max(axis=2) <= tol

    # 굵은 외곽선을 2px 두껍게 막는다. 선에 난 틈으로 오브젝트 안쪽까지
    # 배경이 새어 지워지는 것을 방지 (06obj_light 스위치판 사례)
    # 배경색 자체가 어두운 경우(돌벽 등)는 외곽선이 아니므로 제외한다
    dark = (rgb.max(axis=2) < 100) & ~cand
    if dark.mean() < .25:
        cand &= ~dilate(dilate(dark))

    seen = np.zeros((h, w), bool)
    seen[0] |= cand[0]; seen[-1] |= cand[-1]
    seen[:, 0] |= cand[:, 0]; seen[:, -1] |= cand[:, -1]

    for _ in range(12):
        before = seen.sum()
        for y in range(1, h):
            seen[y] = row_fill(cand[y], seen[y] | (seen[y - 1] & cand[y]))
        for y in range(h - 2, -1, -1):
            seen[y] = row_fill(cand[y], seen[y] | (seen[y + 1] & cand[y]))
        if seen.sum() == before:
            break
    return seen, float(np.mean(seed))


def do_object(path, out):
    im = Image.open(path).convert('RGBA')
    rgb = np.asarray(im.convert('RGB'), dtype=np.int16)
    # 테두리가 어두우면 좁은 허용치 (외곽선까지 먹지 않게)
    edge = np.median(np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]]))
    tol = TOL_DARK if edge < 90 else TOL_LIGHT

    mask, _ = bg_mask(rgb, tol)
    cleared = mask.mean()

    a = np.asarray(im.getchannel('A')).copy()
    a[mask] = 0

    fill = REPAINT.get(os.path.basename(path))
    if fill:
        chk = ((rgb.max(axis=2) - rgb.min(axis=2) < 14) &
               (rgb.max(axis=2) >= 185) & (rgb.max(axis=2) <= 248) & ~mask)
        px = np.asarray(im.convert('RGB')).copy()
        px[chk] = fill
        im = Image.fromarray(px).convert('RGBA')
    im.putalpha(Image.fromarray(a).filter(ImageFilter.GaussianBlur(0.6)))   # 계단 완화

    box = im.getchannel('A').point(lambda v: 255 if v > 8 else 0).getbbox()
    if box:
        p = 2
        im = im.crop((max(0, box[0] - p), max(0, box[1] - p),
                      min(im.width, box[2] + p), min(im.height, box[3] + p)))

    if max(im.size) > OBJ_MAX:
        s = OBJ_MAX / max(im.size)
        im = im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))), Image.LANCZOS)

    im.quantize(colors=200, method=Image.FASTOCTREE).save(out, optimize=True)
    return cleared, im.size, tol


def do_bg(path, out):
    im = Image.open(path).convert('RGB')
    a = np.asarray(im, dtype=np.int16)
    # 상하 빈 띠 제거
    flat = np.abs(a - np.median(a[3, 3])).max(axis=2) <= 18
    rows = ~flat.all(axis=1)
    ys = np.flatnonzero(rows)
    top, bot = (int(ys[0]), int(ys[-1]) + 1) if len(ys) else (0, im.height)
    cols = ~flat.all(axis=0)
    xs = np.flatnonzero(cols)
    left, right = (int(xs[0]), int(xs[-1]) + 1) if len(xs) else (0, im.width)
    # 우하단 워터마크가 남아 있으면 그만큼 더 잘라낸다
    bot -= max(0, WM_MARGIN - (im.height - bot))
    im = im.crop((left, top, right, max(top + 1, bot)))

    s = max(BG_W / im.width, BG_H / im.height)                    # cover
    im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
    x, y = (im.width - BG_W) // 2, (im.height - BG_H) // 2
    im = im.crop((x, y, x + BG_W, y + BG_H))
    im.save(out, quality=84, optimize=True, progressive=True)
    return (left, top, right, bot)


def main():
    os.makedirs(DST, exist_ok=True)
    files = sorted(f for f in os.listdir(SRC) if f.lower().endswith('.png'))
    tot_in = tot_out = 0
    print(f"{'파일':<24}{'전':>8}{'후':>8}  {'지운배경':>8}  {'출력크기':<12}비고")
    for f in files:
        src = os.path.join(SRC, f)
        sz_in = os.path.getsize(src)
        if f.startswith('bg_'):
            out = os.path.join(DST, f[:-4] + '.jpg')
            do_bg(src, out)
            note = ''
            cleared, size = None, Image.open(out).size
        else:
            out = os.path.join(DST, f)
            cleared, size, tol = do_object(src, out)
            note = ''
            if cleared < .05:  note = '⚠ 배경이 거의 안 지워짐'
            elif cleared > .92: note = '⚠ 너무 많이 지워짐'
            elif tol == TOL_DARK: note = '어두운 배경'
        sz_out = os.path.getsize(out)
        tot_in += sz_in; tot_out += sz_out
        c = f'{cleared*100:.0f}%' if cleared is not None else '-'
        print(f"{f:<24}{sz_in//1024:>7}K{sz_out//1024:>7}K  {c:>8}  {f'{size[0]}x{size[1]}':<12}{note}")
    print(f"\n합계 {tot_in/1024/1024:.1f}MB → {tot_out/1024/1024:.2f}MB "
          f"({tot_out*100//tot_in}%)  출력: {DST}/")


if __name__ == '__main__':
    main()
