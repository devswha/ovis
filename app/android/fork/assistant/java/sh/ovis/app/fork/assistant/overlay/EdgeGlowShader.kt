package sh.ovis.app.fork.assistant.overlay

/** AGSL for [EdgeGlow]. Tuned against Gemini's overlay by rendering it over the reference frames. */
internal const val EdgeGlowShader = """
// Edge glow: a thin light along the window edge that follows the display's rounded corners, a wider bloom at the
// bottom that frays into halftone dots, and colours that drift slowly round the edge (once in 24 s).
uniform float2 size;    // window size, px
uniform float dp;       // px per dp
uniform float4 radii;   // display corner radii, px: top left, top right, bottom right, bottom left
uniform float time;     // seconds
uniform float2 origin;  // where the entrance starts, px
uniform float sweep;    // 0..1: the entrance sweeping from the origin round the edge
uniform float bloom;    // 0..1: the bottom bloom's entrance
uniform float level;    // 0..1: mic level, makes the glow breathe

const float TAU = 6.2831853;

// Distance from p to the rounded window edge, positive inside.
float edgeDistance(float2 p) {
    float2 hs = size * 0.5;
    float radius = p.x < hs.x ? (p.y < hs.y ? radii.x : radii.w) : (p.y < hs.y ? radii.y : radii.z);
    float2 q = abs(p - hs) - (hs - radius);
    return radius - (length(max(q, 0.0)) + min(max(q.x, q.y), 0.0));
}

// Position along the window edge (0..1, clockwise from the top left) of the point a ray from the centre through p hits.
float edgePosition(float2 p) {
    float2 hs = size * 0.5;
    float2 q = p - hs;
    float2 a = abs(q) / hs;
    float2 h = q / max(max(a.x, a.y), 0.0001);
    float s;
    if (a.y >= a.x) {
        s = h.y < 0.0 ? h.x + hs.x : size.x + size.y + (hs.x - h.x);
    } else {
        s = h.x > 0.0 ? size.x + (h.y + hs.y) : 2.0 * size.x + size.y + (hs.y - h.y);
    }
    return s / (2.0 * (size.x + size.y));
}

// Mostly blue, with cyan and violet near the upper right edge and a band of purple near the bottom.
half3 palette(float t) {
    half3 blue = half3(0.31, 0.50, 0.97);
    half3 purple = half3(0.66, 0.40, 0.95);
    half3 violet = half3(0.56, 0.49, 0.96);
    half3 cyan = half3(0.25, 0.78, 0.97);
    t = fract(t);
    half3 c = blue;
    c = mix(c, purple, smoothstep(0.46, 0.54, t) - smoothstep(0.62, 0.70, t));
    c = mix(c, cyan, smoothstep(0.12, 0.19, t) - smoothstep(0.23, 0.29, t));
    c = mix(c, violet, smoothstep(0.22, 0.28, t) - smoothstep(0.32, 0.38, t));
    return c;
}

// Halftone dots on rings around the bottom centre; the dot radius follows the intensity f.
float halftone(float2 p, float f) {
    float2 centre = float2(size.x * 0.5, size.y);
    float2 v = p - centre;
    float pitch = 5.2 * dp;
    float ring = floor(length(v) / pitch + 0.5);
    float ringR = max(ring, 1.0) * pitch;
    float segments = max(floor(TAU * ringR / pitch), 6.0);
    float seg = TAU / segments;
    float stagger = 0.5 * mod(ring, 2.0);
    float index = floor(atan(v.y, v.x) / seg - stagger + 0.5) + stagger;
    float2 dotCentre = centre + ringR * float2(cos(index * seg), sin(index * seg));
    float r = pitch * 0.27 * sqrt(clamp(f / 0.4, 0.0, 1.0));
    return (1.0 - smoothstep(r - 0.7, r + 0.7, length(p - dotCentre))) * smoothstep(0.02, 0.09, f);
}

half4 main(float2 p) {
    float d = edgeDistance(p);
    float s = edgePosition(p);

    // The entrance: the glow lights up from the origin and reaches the far side last.
    float away = abs(s - edgePosition(origin));
    away = min(away, 1.0 - away) * 2.0;
    float front = sweep * 1.3;
    float reveal = 1.0 - smoothstep(front - 0.25, front, away);
    float lead = (away - front + 0.12) / 0.1;
    float head = 1.0 + 0.6 * exp(-lead * lead);

    float breathe = 1.0 + 0.45 * level;
    float width = 13.0 * dp * (1.0 + 0.3 * level);

    // Thin bright rim plus a soft body; the top is dimmer than the sides.
    float side = mix(0.52, 1.0, smoothstep(0.0, 0.12, p.y / size.y));
    float rim = 0.30 * exp(-d / (0.8 * dp));
    float body = 0.60 * (1.0 - smoothstep(0.7 * dp, width, d));
    float edge = (rim + body) * side * reveal * head * breathe;

    // The bottom bloom: a wash up each lower side, taking turns slowly, and a band along the bottom that frays
    // into halftone dots. Measured in the reference's 2.75 px/dp units.
    float u = dp / 2.75;
    float h = (size.y - p.y) / u;
    float corner = min(p.x, size.x - p.x) / u;
    float across = abs(p.x / size.x - 0.5) * 2.0;
    float turn = 0.5 + 0.5 * cos(time * 0.4 + 3.14159 * smoothstep(0.3, 0.7, p.x / size.x));
    float washReach = 250.0 * (1.0 - smoothstep(500.0, 900.0, h));
    float wash = 0.97 * (0.12 + 0.88 * turn) * (1.0 - smoothstep(0.0, max(washReach, 1.0), corner));
    float bandReach = mix(380.0, 560.0, smoothstep(0.3, 0.9, across)) * (0.7 + 0.3 * turn);
    float band = 0.85 * (1.0 - smoothstep(0.0, bandReach, h));
    float shown = bloom * breathe * (0.35 + 0.65 * reveal);
    float fb = band * shown;
    float dots = fb;
    if (fb < 0.44) {
        dots = mix(halftone(p, fb) * 0.8, fb, smoothstep(0.26, 0.44, fb));
    }

    float a = 1.0 - (1.0 - clamp(edge, 0.0, 1.0)) * (1.0 - dots) * (1.0 - wash * shown);
    half3 color = palette(s + time / 24.0 + 0.06 * sin(s * TAU * 2.0 + time * 0.3));
    return half4(color * a, a);
}
"""
