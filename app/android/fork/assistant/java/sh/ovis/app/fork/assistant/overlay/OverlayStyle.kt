package sh.ovis.app.fork.assistant.overlay

import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import sh.ovis.app.R

/** Blue and violet, with Gemini's contrast. */
internal object OverlayColors {
    /** Near-black with a navy tint, a little see-through so the glow shows at the edges. */
    val Surface = Color(0xF0050714)
    /** Icons, hint and labels. */
    val Content = Color(0xFFE4E8FF)
    val Mic = Color(0xFF3D3A8C)
}

/** Sizes measured from Gemini's overlay on the 1672 × 2364 panel (density 2.75). */
internal object OverlayDimens {
    /** On wide screens the overlay sits in a phone-wide column, centered on the screen. */
    val ColumnAnchor: Alignment = Alignment.BottomCenter
    val ColumnMaxWidth = 425.dp
    val PillMaxWidth = 344.dp
    val MinSideMargin = 16.dp
    val BottomMargin = 9.dp

    val PillHeight = 76.dp
    val ButtonGap = 8.dp
    /** Where the pill's content starts and ends, with no buttons in it. */
    val PillTextStart = 14.dp

    val Halo = 12.dp
    val SoftEdge = 3.5.dp
}

internal val GoogleSansText = FontFamily(
    Font(R.font.google_sans_text_regular, FontWeight.Normal),
    Font(R.font.google_sans_text_medium, FontWeight.Medium),
)

internal object OverlayType {
    val Hint = TextStyle(fontFamily = GoogleSansText, fontSize = 18.sp, color = OverlayColors.Content)
    val Note = Hint.copy(fontSize = 16.sp, fontWeight = FontWeight.Medium)
    /** Small and quiet, with digits of one width so a count that changes every second doesn't shake. */
    val Caption = TextStyle(
        fontFamily = GoogleSansText,
        fontSize = 12.sp,
        color = OverlayColors.Content.copy(alpha = 0.7f),
        fontFeatureSettings = "tnum",
    )
}
